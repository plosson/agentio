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

// DriveFile is the list item gdocs, gsheets and gslides return (Bun
// GDocsDocument, GSheetsListItem, GSlidesListItem).
type DriveFile struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Owner        string `json:"owner,omitempty"`
	CreatedTime  string `json:"createdTime,omitempty"`
	ModifiedTime string `json:"modifiedTime,omitempty"`
	WebViewLink  string `json:"webViewLink"`
}

// ListDriveFiles is their list(): the most recently modified non-trashed
// files of mimeType, query ANDed on, pageSize Math.min(limit, 100). A file
// without a name is "Untitled"; one without a link gets linkPrefix + id. The
// error is the Drive call's, for the product's own "Failed to ..." wrapping.
func ListDriveFiles(ctx context.Context, svc *drive.Service, mimeType, query string, limit float64, linkPrefix string) ([]DriveFile, error) {
	q := "mimeType='" + mimeType + "' and trashed=false"
	if query != "" {
		q += " and " + query
	}
	resp, err := svc.Files.List().Q(q).
		Fields("files(id,name,owners,createdTime,modifiedTime,webViewLink)").
		OrderBy("modifiedTime desc").Context(ctx).Do(PageSize(limit))
	if err != nil {
		return nil, err
	}
	out := []DriveFile{}
	for _, f := range resp.Files {
		d := DriveFile{ID: f.Id, Title: f.Name, CreatedTime: f.CreatedTime, ModifiedTime: f.ModifiedTime, WebViewLink: f.WebViewLink}
		if d.Title == "" {
			d.Title = "Untitled"
		}
		if len(f.Owners) > 0 && f.Owners[0] != nil {
			d.Owner = f.Owners[0].DisplayName
			if d.Owner == "" {
				d.Owner = f.Owners[0].EmailAddress
			}
		}
		if d.WebViewLink == "" {
			d.WebViewLink = linkPrefix + f.Id
		}
		out = append(out, d)
	}
	return out, nil
}

// FormatDriveFiles is their printXList: heading is the plural ("Documents"),
// empty the line printed for no files ("No documents found").
func FormatDriveFiles(v any, heading, empty string) string {
	files, _ := v.([]DriveFile)
	if len(files) == 0 {
		return empty
	}
	lines := []string{fmt.Sprintf("%s (%d)", heading, len(files)), ""}
	for i, d := range files {
		lines = append(lines, fmt.Sprintf("[%d] %s", i+1, d.Title), "    ID: "+d.ID)
		if d.Owner != "" {
			lines = append(lines, "    Owner: "+d.Owner)
		}
		if d.ModifiedTime != "" {
			lines = append(lines, "    Modified: "+d.ModifiedTime)
		}
		lines = append(lines, "    Link: "+d.WebViewLink, "")
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
		email, _ := run.Credentials["email"].(string)
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

// CreatedFile is what gsheets and gslides return from create and copy (Bun
// GSheetsCreateResult, GSlidesCreateResult).
type CreatedFile struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

// CopyDriveFile is their copy(): Drive files.copy of fileID named title, into
// parentFolderID when given. The title is kept, and linkPrefix + id is the URL,
// when Drive returns none. A failure is Failed(operation).
func (a API) CopyDriveFile(svc *drive.Service, fileID, title, parentFolderID, operation, linkPrefix string) (*CreatedFile, error) {
	file := &drive.File{Name: title, ForceSendFields: []string{"Name"}} // "" is sent, as Bun sends it
	if parentFolderID != "" {
		file.Parents = []string{parentFolderID}
	}
	f, err := svc.Files.Copy(fileID, file).Fields("id,name,webViewLink").Context(a.Ctx).Do()
	if err != nil {
		return nil, a.Failed(operation, err)
	}
	out := &CreatedFile{ID: f.Id, Title: f.Name, URL: f.WebViewLink}
	if out.Title == "" {
		out.Title = title
	}
	if out.URL == "" {
		out.URL = linkPrefix + f.Id
	}
	return out, nil
}

// FormatCreatedFile is their printXCreated: heading is the first line
// ("Spreadsheet created").
func FormatCreatedFile(v any, heading string) string {
	c, _ := v.(*CreatedFile)
	if c == nil {
		return ""
	}
	return strings.Join([]string{heading, "ID: " + c.ID, "Title: " + c.Title, "URL: " + c.URL}, "\n")
}
