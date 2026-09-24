package gdocs

import (
	"context"
	"io"
	"net/url"
	"regexp"
	"strconv"
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

// created is GDocsCreateResult.
type created struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	WebViewLink string `json:"webViewLink"`
}

// tab is GDocsTab.
type tab struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Depth int    `json:"depth"`
}

// batchResult is what printGDocsBatchResult prints: replies are the API's own
// objects, in its order.
type batchResult struct {
	DocumentID string `json:"documentId"`
	Replies    any    `json:"replies"`
}

// api is GDocsClient. Drive calls go through the typed drive/v3 client. Docs
// responses are printed or forwarded as the API sent them (structure, batch),
// so Docs calls send and read ordered JSON at the docs/v1 client's BasePath.
type api struct {
	ctx      context.Context
	run      *plugins.RunContext
	drive    *drive.Service
	docsBase string
	fail     func(code plugins.ErrorCode, message, suggestion string) error
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
	return &api{ctx: ctx, run: run, drive: driveSvc, docsBase: docsSvc.BasePath, fail: run.Fail}, nil
}

// apiError is GDocsClient.throwApiError.
func (a *api) apiError(operation string, err error) error {
	message := google.StatusMessage(err, "Insufficient permissions to access this document", "Document not found")
	return a.fail(google.ErrorCode(err), "Failed to "+operation+": "+message, "")
}

var docIDPattern = regexp.MustCompile(`/document/d/([a-zA-Z0-9_-]+)`)

// extractDocID accepts a document ID or any URL containing /document/d/<id>.
func extractDocID(docIDOrURL string) string {
	if m := docIDPattern.FindStringSubmatch(docIDOrURL); m != nil {
		return m[1]
	}
	return docIDOrURL
}

// export is getAsMarkdown / getAsDocx: the Drive export bytes.
func (a *api) export(docIDOrURL, mimeType, operation string) ([]byte, error) {
	resp, err := a.drive.Files.Export(extractDocID(docIDOrURL), mimeType).Context(a.ctx).Download()
	if err != nil {
		return nil, a.apiError(operation, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, a.apiError(operation, err)
	}
	return body, nil
}

func (a *api) create(title, markdown, folderID string) (*created, error) {
	file := &drive.File{Name: title, MimeType: docMimeType}
	if folderID != "" {
		file.Parents = []string{folderID}
	}
	f, err := a.drive.Files.Create(file).
		Media(strings.NewReader(markdown), googleapi.ContentType("text/markdown")).
		Fields("id,name,webViewLink").Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("create document", err)
	}
	out := &created{ID: f.Id, Title: f.Name, WebViewLink: f.WebViewLink}
	if out.Title == "" {
		out.Title = title
	}
	if out.WebViewLink == "" {
		out.WebViewLink = "https://docs.google.com/document/d/" + f.Id
	}
	return out, nil
}

func (a *api) list(limit float64, query string) ([]google.DriveFile, error) {
	files, err := google.ListDriveFiles(a.ctx, a.drive, docMimeType, query, limit, "https://docs.google.com/document/d/")
	if err != nil {
		return nil, a.apiError("list documents", err)
	}
	return files, nil
}

// getDocument is docs.documents.get as the API sent it.
func (a *api) getDocument(documentID string, includeTabsContent bool, operation string) (*jsvalue.Object, error) {
	path := "v1/documents/" + url.PathEscape(documentID) + "?includeTabsContent=" + strconv.FormatBool(includeTabsContent)
	v, err := google.CallJSON(a.ctx, a.run, google.Camel, "GET", a.docsBase, path, nil)
	if err != nil {
		return nil, a.apiError(operation, err)
	}
	doc, _ := v.(*jsvalue.Object)
	return doc, nil
}

// structure is getStructure: the whole document, or one tab's documentTab.
func (a *api) structure(docIDOrURL, tabID string, allTabs bool) (any, error) {
	doc, err := a.getDocument(extractDocID(docIDOrURL), tabID != "" || allTabs, "get document structure")
	if err != nil {
		return nil, err
	}
	if tabID == "" {
		return doc, nil
	}
	found := findTab(children(doc, "tabs"), tabID)
	if found == nil {
		var available []string
		for _, t := range flattenTabs(children(doc, "tabs"), 0) {
			available = append(available, t.ID+" ("+t.Title+")")
		}
		suggestion := "Run: agentio gdocs tabs <doc-id-or-url>"
		if len(available) > 0 {
			suggestion = "Available tabs: " + strings.Join(available, ", ")
		}
		return nil, a.fail("NOT_FOUND", "Tab not found: "+tabID, suggestion)
	}
	documentTab, ok := found.Get("documentTab")
	if !ok {
		// console.log(JSON.stringify(undefined))
		return "undefined", nil
	}
	return documentTab, nil
}

func (a *api) listTabs(docIDOrURL string) ([]tab, error) {
	// The API only populates `tabs` when includeTabsContent is true.
	doc, err := a.getDocument(extractDocID(docIDOrURL), true, "list document tabs")
	if err != nil {
		return nil, err
	}
	return flattenTabs(children(doc, "tabs"), 0), nil
}

func (a *api) batch(docIDOrURL string, requests []any) (*batchResult, error) {
	documentID := extractDocID(docIDOrURL)
	if len(requests) == 0 {
		return nil, a.fail("INVALID_PARAMS", "requests must be a non-empty array", "")
	}
	body := append(append([]byte(`{"requests":`), jsvalue.Stringify(requests)...), '}')
	v, err := google.CallJSON(a.ctx, a.run, google.Camel, "POST", a.docsBase, "v1/documents/"+url.PathEscape(documentID)+":batchUpdate", body)
	if err != nil {
		return nil, a.apiError("execute batch update", err)
	}
	var replies any = []any{}
	if resp, ok := v.(*jsvalue.Object); ok {
		if r, _ := resp.Get("replies"); r != nil {
			replies = r
		}
	}
	return &batchResult{DocumentID: documentID, Replies: replies}, nil
}

// children is `obj?.[key] ?? []` for a list of objects.
func children(obj *jsvalue.Object, key string) []*jsvalue.Object {
	v, _ := obj.Get(key)
	items, _ := v.([]any)
	var out []*jsvalue.Object
	for _, item := range items {
		if o, ok := item.(*jsvalue.Object); ok {
			out = append(out, o)
		}
	}
	return out
}

// tabProperty is `tab.tabProperties?.[key] ?? ""`.
func tabProperty(t *jsvalue.Object, key string) string {
	props, _ := t.Get("tabProperties")
	obj, _ := props.(*jsvalue.Object)
	v, _ := obj.Get(key)
	s, _ := v.(string)
	return s
}

func flattenTabs(tabs []*jsvalue.Object, depth int) []tab {
	out := []tab{}
	for _, t := range tabs {
		out = append(out, tab{ID: tabProperty(t, "tabId"), Title: tabProperty(t, "title"), Depth: depth})
		out = append(out, flattenTabs(children(t, "childTabs"), depth+1)...)
	}
	return out
}

func findTab(tabs []*jsvalue.Object, tabID string) *jsvalue.Object {
	for _, t := range tabs {
		if tabProperty(t, "tabId") == tabID {
			return t
		}
		if child := findTab(children(t, "childTabs"), tabID); child != nil {
			return child
		}
	}
	return nil
}
