package google

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	drive "google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
)

// DriveService is the drive/v3 client the Drive-backed products (gdocs,
// gdrive, gsheets, gslides, gscript) build. They all store Camel credentials.
func DriveService(ctx context.Context, run *plugins.RunContext) (*drive.Service, error) {
	return NewService(ctx, run, Camel, drive.NewService)
}

// PageSize is Bun `pageSize: Math.min(limit, 100)` on a Drive list call: NaN
// (a --limit that parseInt rejects) is sent as "NaN", as gaxios does.
func PageSize(limit float64) googleapi.CallOption {
	if limit > 100 {
		limit = 100
	}
	return googleapi.QueryParameter("pageSize", jsvalue.NumberString(limit))
}

// ListDriveFiles is the list() of gdocs, gsheets and gslides: the most
// recently modified non-trashed files of mimeType, query ANDed on, pageSize
// Math.min(limit, 100). Each item is the Bun list object (GDocsDocument,
// GSheetsListItem, GSlidesListItem) built from the answer: a file without a
// name is "Untitled", one without a link gets linkPrefix + its id (undefined
// when missing, as Bun's template prints it). The error is the call's or
// Bun's TypeError, for the product's own "Failed to ..." wrapping.
func ListDriveFiles(ctx context.Context, svc *drive.Service, mimeType, query string, limit float64, linkPrefix string) ([]any, error) {
	q := "mimeType='" + mimeType + "' and trashed=false"
	if query != "" {
		q += " and " + query
	}
	_, raw, err := Answer(ctx, svc.Files.List().Q(q).
		Fields("files(id,name,owners,createdTime,modifiedTime,webViewLink)").
		OrderBy("modifiedTime desc"), PageSize(limit))
	if err != nil {
		return nil, err
	}
	files, err := jsvalue.Path(raw, listedData, "files")
	if err != nil {
		return nil, err
	}
	items, err := jsvalue.Items(jsvalue.Or(files, []any{}), "files")
	if err != nil {
		return nil, err
	}
	out := []any{}
	for _, file := range items {
		if jsvalue.Nullish(file) {
			return nil, jsvalue.TypeError(file, "file.id")
		}
		get := func(k string) any { return jsvalue.Member(file, k) }
		// file.owners?.[0]?.displayName || file.owners?.[0]?.emailAddress || undefined
		first := jsvalue.Optional(get("owners"), "0")
		owner := jsvalue.Or(jsvalue.Or(jsvalue.Optional(first, "displayName"), jsvalue.Optional(first, "emailAddress")), jsvalue.Undefined)
		out = append(out, jsvalue.ObjectOf(
			"id", get("id"),
			"title", jsvalue.Or(get("name"), "Untitled"),
			"owner", owner,
			"createdTime", jsvalue.Or(get("createdTime"), jsvalue.Undefined),
			"modifiedTime", jsvalue.Or(get("modifiedTime"), jsvalue.Undefined),
			"webViewLink", jsvalue.Or(get("webViewLink"), linkPrefix+jsvalue.String(get("id"))),
		))
	}
	return out, nil
}

// listedData is how Bun's build names the list answer's data in a TypeError:
// it inlines `response`.
const listedData = `(await this.drive.files.list({
        pageSize: Math.min(limit, 100),
        q,
        fields: "files(id,name,owners,createdTime,modifiedTime,webViewLink)",
        orderBy: "modifiedTime desc"
      })).data`

// FormatDriveFiles is their printXList: heading is the plural ("Documents"),
// empty the line printed for no files ("No documents found").
func FormatDriveFiles(v any, heading, empty string) string {
	files, _ := v.([]any)
	if len(files) == 0 {
		return empty
	}
	lines := []string{fmt.Sprintf("%s (%d)", heading, len(files)), ""}
	for i, d := range files {
		lines = append(lines, fmt.Sprintf("[%d] %s", i+1, Field(d, "title")), "    ID: "+Field(d, "id"))
		if Truthy(d, "owner") {
			lines = append(lines, "    Owner: "+Field(d, "owner"))
		}
		if Truthy(d, "modifiedTime") {
			lines = append(lines, "    Modified: "+Field(d, "modifiedTime"))
		}
		lines = append(lines, "    Link: "+Field(d, "webViewLink"), "")
	}
	return strings.Join(lines, "\n")
}

// ValidateDriveFiles is the validate() of the Drive-backed products: one file
// of mimeType is listed, and the account is the stored email.
func ValidateDriveFiles(mimeType string) func(context.Context, *plugins.RunContext) (plugins.ValidationResult, error) {
	return func(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
		svc, err := DriveService(ctx, run)
		if err != nil {
			return ValidationFailure(err), nil
		}
		if _, err := svc.Files.List().PageSize(1).Q("mimeType='" + mimeType + "'").Context(ctx).Do(); err != nil {
			return ValidationFailure(err), nil
		}
		email, _ := run.Credentials.Value("email").(string)
		return plugins.ValidationResult{Valid: true, Info: email}, nil
	}
}

// ExportDriveFile is the export of the Drive-backed products (gdocs, gsheets,
// gslides): the file's bytes as mimeType. A failure is Failed(operation).
func (a API) ExportDriveFile(svc *drive.Service, fileID, mimeType, operation string) ([]byte, error) {
	resp, err := svc.Files.Export(fileID, mimeType).Context(a.Ctx).Download()
	if err != nil {
		return nil, a.Failed(operation, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, a.Failed(operation, err)
	}
	return body, nil
}

// CopyDriveFile is the copy() of gsheets and gslides: Drive files.copy of
// fileID named title, into parentFolderID when given. The result is Bun's
// { id, title, url }: the title is kept, and linkPrefix + id is the URL, when
// Drive returns none. A failure is Failed(operation).
func (a API) CopyDriveFile(svc *drive.Service, fileID, title, parentFolderID, operation, linkPrefix string) (*jsvalue.Object, error) {
	file := &drive.File{Name: title, ForceSendFields: []string{"Name"}} // "" is sent, as Bun sends it
	if parentFolderID != "" {
		file.Parents = []string{parentFolderID}
	}
	_, raw, err := Answer(a.Ctx, svc.Files.Copy(fileID, file).Fields("id,name,webViewLink"))
	if err == nil && jsvalue.Nullish(raw) {
		err = jsvalue.TypeError(raw, "response.data.id")
	}
	if err != nil {
		return nil, a.Failed(operation, err)
	}
	get := func(k string) any { return jsvalue.Member(raw, k) }
	return jsvalue.ObjectOf(
		"id", get("id"),
		"title", jsvalue.Or(get("name"), title),
		"url", jsvalue.Or(get("webViewLink"), linkPrefix+jsvalue.String(get("id"))),
	), nil
}

// FormatCreatedFile is their printXCreated: heading is the first line
// ("Spreadsheet created"), then the { id, title, url } result.
func FormatCreatedFile(v any, heading string) string {
	return strings.Join([]string{heading, "ID: " + Field(v, "id"), "Title: " + Field(v, "title"), "URL: " + Field(v, "url")}, "\n")
}
