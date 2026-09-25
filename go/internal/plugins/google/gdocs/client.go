package gdocs

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	docs "google.golang.org/api/docs/v1"
	drive "google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
)

const (
	docMimeType  = "application/vnd.google-apps.document"
	docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

// The results are the Bun client's objects (GDocsCreateResult, GDocsTab and
// the batch result), built from the answer as Bun's googleapis client reads
// it (google.Answer): a field the answer lacks is undefined, and reading a
// member of a null answer or item fails with Bun's TypeError.

// api is GDocsClient: typed drive/v3 and docs/v1 clients build the requests.
type api struct {
	google.API
	drive *drive.Service
	docs  *docs.Service
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	driveSvc, err := google.DriveService(ctx, run)
	if err != nil {
		return nil, err
	}
	docsSvc, err := google.NewService(ctx, run, google.Camel, docs.NewService)
	if err != nil {
		return nil, err
	}
	return &api{API: google.API{Ctx: ctx, RunContext: run, ErrorMessage: errorMessage}, drive: driveSvc, docs: docsSvc}, nil
}

// errorMessage is GDocsClient.getErrorMessage.
var errorMessage = google.StatusText("Insufficient permissions to access this document", "Document not found")

var docIDPattern = regexp.MustCompile(`/document/d/([a-zA-Z0-9_-]+)`)

// extractDocID accepts a document ID or any URL containing /document/d/<id>.
func extractDocID(docIDOrURL string) string {
	if m := docIDPattern.FindStringSubmatch(docIDOrURL); m != nil {
		return m[1]
	}
	return docIDOrURL
}

func (a *api) create(title, markdown, folderID string) (*jsvalue.Object, error) {
	// Bun sends name as given, "" included.
	file := &drive.File{Name: title, MimeType: docMimeType, ForceSendFields: []string{"Name"}}
	if folderID != "" {
		file.Parents = []string{folderID}
	}
	call := a.drive.Files.Create(file).
		// ChunkSize(0) sends one multipart request whatever the size, as Bun does.
		Media(strings.NewReader(markdown), googleapi.ContentType("text/markdown"), googleapi.ChunkSize(0)).
		Fields("id,name,webViewLink")
	_, data, err := google.Answer(a.Ctx, call)
	if err == nil && jsvalue.Nullish(data) {
		err = jsvalue.TypeError(data, "response.data.id")
	}
	if err != nil {
		return nil, a.Failed("create document", err)
	}
	id := jsvalue.Member(data, "id")
	return jsvalue.ObjectOf(
		"id", id,
		"title", jsvalue.Or(jsvalue.Member(data, "name"), title),
		"webViewLink", jsvalue.Or(jsvalue.Member(data, "webViewLink"), "https://docs.google.com/document/d/"+jsvalue.String(id)),
	), nil
}

func (a *api) list(limit float64, query string) ([]any, error) {
	files, err := google.ListDriveFiles(a.Ctx, a.drive, docMimeType, query, limit, "https://docs.google.com/document/d/")
	if err != nil {
		return nil, a.Failed("list documents", err)
	}
	return files, nil
}

// getDocument is docs.documents.get: response.data as Bun reads it.
func (a *api) getDocument(documentID string, includeTabsContent bool) (any, error) {
	_, data, err := google.Answer(a.Ctx, a.docs.Documents.Get(documentID).IncludeTabsContent(includeTabsContent))
	return data, err
}

// structure is getStructure: the whole document, or one tab's documentTab.
// Only the documents.get call is inside Bun's try: a TypeError after it is
// the bare error.
func (a *api) structure(docIDOrURL, tabID string, allTabs bool) (any, error) {
	doc, err := a.getDocument(extractDocID(docIDOrURL), tabID != "" || allTabs)
	if err != nil {
		return nil, a.Failed("get document structure", err)
	}
	if tabID == "" {
		return doc, nil
	}
	if jsvalue.Nullish(doc) {
		return nil, jsvalue.TypeError(doc, "document.tabs")
	}
	tabs := nullish(jsvalue.Member(doc, "tabs"), []any{})
	found, err := findTab(tabs, tabID)
	if err != nil {
		return nil, err
	}
	if found == nil {
		flat, err := flattenTabs(tabs, 0)
		if err != nil {
			return nil, err
		}
		var available []string
		for _, t := range flat {
			available = append(available, google.Field(t, "id")+" ("+google.Field(t, "title")+")")
		}
		suggestion := "Run: agentio gdocs tabs <doc-id-or-url>"
		if len(available) > 0 {
			suggestion = "Available tabs: " + strings.Join(available, ", ")
		}
		return nil, a.Fail("NOT_FOUND", "Tab not found: "+tabID, suggestion)
	}
	return jsvalue.Member(found, "documentTab"), nil
}

func (a *api) listTabs(docIDOrURL string) ([]any, error) {
	// The API only populates `tabs` when includeTabsContent is true.
	doc, err := a.getDocument(extractDocID(docIDOrURL), true)
	var tabs []any
	if err == nil {
		var list any
		if list, err = jsvalue.Path(doc, "response.data", "tabs"); err == nil {
			tabs, err = flattenTabs(nullish(list, []any{}), 0)
		}
	}
	if err != nil {
		return nil, a.Failed("list document tabs", err)
	}
	return tabs, nil
}

// batch sends the requests verbatim through CallJSON: the docs/v1 Request
// structs would drop fields they do not know and false or zero values.
func (a *api) batch(docIDOrURL string, requests []any) (*jsvalue.Object, error) {
	documentID := extractDocID(docIDOrURL)
	if len(requests) == 0 {
		return nil, a.Fail("INVALID_PARAMS", "requests must be a non-empty array", "")
	}
	body := append(append([]byte(`{"requests":`), jsvalue.Stringify(requests)...), '}')
	data, err := google.CallJSON(a.Ctx, a.RunContext, google.Camel, "POST", a.docs.BasePath, "v1/documents/"+url.PathEscape(documentID)+":batchUpdate", body)
	var replies any
	if err == nil {
		replies, err = jsvalue.Path(data, "response.data", "replies")
	}
	if err != nil {
		return nil, a.Failed("execute batch update", err)
	}
	return jsvalue.ObjectOf("documentId", documentID, "replies", nullish(replies, []any{})), nil
}

// nullish is `v ?? fallback`.
func nullish(v, fallback any) any {
	if jsvalue.Nullish(v) {
		return fallback
	}
	return v
}

// tabList is the array a tab list is walked as; a value that is not one has
// no flatMap or iterator in Bun either.
func tabList(v any, text string) ([]any, error) {
	items, ok := v.([]any)
	if !ok {
		return nil, errors.New(text + " is not a function")
	}
	return items, nil
}

// tabProperty is `tab.tabProperties?.[key] ?? ""` on a tab that must not be
// null.
func tabProperty(t any, key string) (any, error) {
	if jsvalue.Nullish(t) {
		return nil, jsvalue.TypeError(t, "tab.tabProperties")
	}
	return nullish(jsvalue.Optional(jsvalue.Member(t, "tabProperties"), key), ""), nil
}

// flattenTabs is GDocsClient.flattenTabs: GDocsTab objects, depth first.
func flattenTabs(v any, depth int) ([]any, error) {
	tabs, err := tabList(v, "tabs.flatMap")
	if err != nil {
		return nil, err
	}
	out := []any{}
	for _, t := range tabs {
		id, err := tabProperty(t, "tabId")
		if err != nil {
			return nil, err
		}
		title, _ := tabProperty(t, "title")
		out = append(out, jsvalue.ObjectOf("id", id, "title", title, "depth", depth))
		children, err := flattenTabs(nullish(jsvalue.Member(t, "childTabs"), []any{}), depth+1)
		if err != nil {
			return nil, err
		}
		out = append(out, children...)
	}
	return out, nil
}

// findTab is GDocsClient.findTab: the first tab, depth first, whose tabId is
// tabID (===), or nil.
func findTab(v any, tabID string) (any, error) {
	tabs, err := tabList(v, "tabs[Symbol.iterator]")
	if err != nil {
		return nil, err
	}
	for _, t := range tabs {
		if jsvalue.Nullish(t) {
			return nil, jsvalue.TypeError(t, "tab.tabProperties")
		}
		if jsvalue.StrictEqual(jsvalue.Optional(jsvalue.Member(t, "tabProperties"), "tabId"), tabID) {
			return t, nil
		}
		child, err := findTab(nullish(jsvalue.Member(t, "childTabs"), []any{}), tabID)
		if err != nil || child != nil {
			return child, err
		}
	}
	return nil, nil
}
