package gdrive

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	drive "google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
)

const (
	folderMimeType = "application/vnd.google-apps.folder"
	fileFields     = "id,name,mimeType,size,createdTime,modifiedTime,owners,parents,webViewLink,webContentLink,starred,trashed,shared,description"
)

// file is GDriveFile.
type file struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	MimeType       string   `json:"mimeType"`
	Size           int64    `json:"size,omitempty"`
	CreatedTime    string   `json:"createdTime,omitempty"`
	ModifiedTime   string   `json:"modifiedTime,omitempty"`
	Owners         []string `json:"owners,omitempty"`
	Parents        []string `json:"parents,omitempty"`
	WebViewLink    string   `json:"webViewLink,omitempty"`
	WebContentLink string   `json:"webContentLink,omitempty"`
	Starred        bool     `json:"starred"`
	Trashed        bool     `json:"trashed"`
	Shared         bool     `json:"shared"`
	Description    string   `json:"description,omitempty"`
}

// fileList is a list result with the printGDriveFileList title.
type fileList struct {
	Title string
	Files []file
}

// MarshalJSON prints the files only, without escaping <, > and & (the host's
// JSON.stringify rendering).
func (l fileList) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(l.Files); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// downloaded is GDriveDownloadResult.
type downloaded struct {
	Filename string `json:"filename"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType"`
}

// uploaded is GDriveUploadResult, plus the permission `put --public` created.
type uploaded struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	MimeType    string  `json:"mimeType"`
	Size        int64   `json:"size"`
	WebViewLink string  `json:"webViewLink,omitempty"`
	Share       *shared `json:"share,omitempty"`
}

// copied is GDriveCopyResult.
type copied struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	MimeType    string   `json:"mimeType"`
	Parents     []string `json:"parents,omitempty"`
	WebViewLink string   `json:"webViewLink,omitempty"`
}

// permission is GDrivePermission.
type permission struct {
	ID                 string `json:"id"`
	Type               string `json:"type"`
	Role               string `json:"role"`
	EmailAddress       string `json:"emailAddress,omitempty"`
	Domain             string `json:"domain,omitempty"`
	DisplayName        string `json:"displayName,omitempty"`
	AllowFileDiscovery bool   `json:"allowFileDiscovery,omitempty"`
}

// shared is GDriveShareResult. FileID is the id printGDriveShared puts in the
// public URL.
type shared struct {
	PermissionID string `json:"permissionId"`
	Type         string `json:"type"`
	Role         string `json:"role"`
	EmailAddress string `json:"emailAddress,omitempty"`
	Domain       string `json:"domain,omitempty"`
	FileID       string `json:"-"`
}

// unshared is what `unshare` reports.
type unshared struct {
	FileID       string `json:"fileId"`
	PermissionID string `json:"permissionId"`
}

type exportFormat struct{ format, mimeType string }

// exportFormats is EXPORT_MIME_TYPES without the undefined entries, in the
// order getSupportedExportFormats lists them.
var exportFormats = map[string][]exportFormat{
	"application/vnd.google-apps.document": {
		{"pdf", "application/pdf"},
		{"docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{"odt", "application/vnd.oasis.opendocument.text"},
		{"txt", "text/plain"},
		{"html", "text/html"},
		{"rtf", "application/rtf"},
	},
	"application/vnd.google-apps.spreadsheet": {
		{"xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
		{"csv", "text/csv"},
		{"pdf", "application/pdf"},
		{"ods", "application/vnd.oasis.opendocument.spreadsheet"},
		{"tsv", "text/tab-separated-values"},
	},
	"application/vnd.google-apps.presentation": {
		{"pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
		{"pdf", "application/pdf"},
		{"odp", "application/vnd.oasis.opendocument.presentation"},
		{"txt", "text/plain"},
	},
	"application/vnd.google-apps.drawing": {
		{"pdf", "application/pdf"},
		{"png", "image/png"},
		{"jpeg", "image/jpeg"},
		{"svg", "image/svg+xml"},
	},
}

// convertibleMimeTypes is CONVERTIBLE_MIME_TYPES.
var convertibleMimeTypes = map[string]string{
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.google-apps.document",
	"application/msword":                      "application/vnd.google-apps.document",
	"application/vnd.oasis.opendocument.text": "application/vnd.google-apps.document",
	"text/plain":                              "application/vnd.google-apps.document",
	"text/html":                               "application/vnd.google-apps.document",
	"application/rtf":                         "application/vnd.google-apps.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.google-apps.spreadsheet",
	"application/vnd.ms-excel":                       "application/vnd.google-apps.spreadsheet",
	"application/vnd.oasis.opendocument.spreadsheet": "application/vnd.google-apps.spreadsheet",
	"text/csv":                  "application/vnd.google-apps.spreadsheet",
	"text/tab-separated-values": "application/vnd.google-apps.spreadsheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/vnd.google-apps.presentation",
	"application/vnd.ms-powerpoint":                                             "application/vnd.google-apps.presentation",
	"application/vnd.oasis.opendocument.presentation":                           "application/vnd.google-apps.presentation",
}

// extToMime is EXT_TO_MIME.
var extToMime = map[string]string{
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".doc":  "application/msword",
	".odt":  "application/vnd.oasis.opendocument.text",
	".txt":  "text/plain",
	".html": "text/html",
	".htm":  "text/html",
	".rtf":  "application/rtf",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xls":  "application/vnd.ms-excel",
	".ods":  "application/vnd.oasis.opendocument.spreadsheet",
	".csv":  "text/csv",
	".tsv":  "text/tab-separated-values",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".ppt":  "application/vnd.ms-powerpoint",
	".odp":  "application/vnd.oasis.opendocument.presentation",
}

// workspaceTypeNames is getWorkspaceTypeName.
var workspaceTypeNames = map[string]string{
	"application/vnd.google-apps.document":     "Doc",
	"application/vnd.google-apps.spreadsheet":  "Sheet",
	"application/vnd.google-apps.presentation": "Slide",
	"application/vnd.google-apps.drawing":      "Drawing",
	"application/vnd.google-apps.form":         "Form",
}

// api is GDriveClient.
type api struct {
	ctx         context.Context
	svc         *drive.Service
	accessLevel string
	fail        func(code plugins.ErrorCode, message, suggestion string) error
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	svc, err := google.DriveService(ctx, run)
	if err != nil {
		return nil, err
	}
	level, _ := run.Credentials["accessLevel"].(string)
	return &api{ctx: ctx, svc: svc, accessLevel: level, fail: run.Fail}, nil
}

// apiError is GDriveClient.throwApiError. Unlike the other Google clients,
// gdrive prefers the API's own message and uses the fixed status text only
// when that message is blank.
func (a *api) apiError(operation string, err error) error {
	message := google.Message(err)
	if jsvalue.Trim(message) == "" {
		message = google.StatusMessage(err, "Insufficient permissions to access this file", "File not found")
	}
	return a.fail(google.ErrorCode(err), "Failed to "+operation+": "+message, "")
}

// assertWriteAccess treats a missing accessLevel as readonly, as Bun does.
func (a *api) assertWriteAccess() error {
	if a.accessLevel == "" || a.accessLevel == "readonly" {
		return a.fail("PERMISSION_DENIED", "This profile has read-only access", "Create a new profile with full access: agentio gdrive profile add --full")
	}
	return nil
}

var fileIDPatterns = []*regexp.Regexp{
	regexp.MustCompile(`/file/d/([a-zA-Z0-9_-]+)`),
	regexp.MustCompile(`/folders/([a-zA-Z0-9_-]+)`),
	regexp.MustCompile(`id=([a-zA-Z0-9_-]+)`),
}

// extractFileID accepts an ID or a Drive file, folder or ?id= URL.
func extractFileID(fileIDOrURL string) string {
	for _, p := range fileIDPatterns {
		if m := p.FindStringSubmatch(fileIDOrURL); m != nil {
			return m[1]
		}
	}
	return fileIDOrURL
}

func parseFile(f *drive.File) file {
	out := file{
		ID: f.Id, Name: f.Name, MimeType: f.MimeType, Size: f.Size,
		CreatedTime: f.CreatedTime, ModifiedTime: f.ModifiedTime, Parents: f.Parents,
		WebViewLink: f.WebViewLink, WebContentLink: f.WebContentLink,
		Starred: f.Starred, Trashed: f.Trashed, Shared: f.Shared, Description: f.Description,
	}
	if out.Name == "" {
		out.Name = "Untitled"
	}
	if out.MimeType == "" {
		out.MimeType = "application/octet-stream"
	}
	for _, o := range f.Owners {
		name := "Unknown"
		if o != nil && o.DisplayName != "" {
			name = o.DisplayName
		} else if o != nil && o.EmailAddress != "" {
			name = o.EmailAddress
		}
		out.Owners = append(out.Owners, name)
	}
	return out
}

type listOptions struct {
	limit        float64
	folderID     string
	query        string
	orderBy      string
	includeTrash bool
}

// list pages through files.list until limit files are collected.
func (a *api) list(o listOptions) ([]file, error) {
	var parts []string
	if !o.includeTrash {
		parts = append(parts, "trashed = false")
	}
	if o.folderID != "" {
		parts = append(parts, "'"+o.folderID+"' in parents")
	}
	if o.query != "" {
		parts = append(parts, o.query)
	}
	q := strings.Join(parts, " and ")
	all := []file{}
	pageToken := ""
	for {
		call := a.svc.Files.List().Fields("nextPageToken,files(" + fileFields + ")").OrderBy(o.orderBy)
		if q != "" {
			call = call.Q(q)
		}
		if pageToken != "" {
			call = call.PageToken(pageToken)
		}
		resp, err := call.Context(a.ctx).Do(google.PageSize(o.limit - float64(len(all))))
		if err != nil {
			return nil, a.apiError("list files", err)
		}
		for _, f := range resp.Files {
			all = append(all, parseFile(f))
		}
		pageToken = resp.NextPageToken
		if pageToken == "" || !(float64(len(all)) < o.limit) {
			break
		}
	}
	return all[:sliceEnd(o.limit, len(all))], nil
}

// sliceEnd is the end index Array.prototype.slice(0, limit) uses.
func sliceEnd(limit float64, n int) int {
	switch {
	case math.IsNaN(limit):
		return 0
	case limit < 0:
		return max(0, n+int(math.Ceil(limit)))
	case limit > float64(n):
		return n
	default:
		return int(limit)
	}
}

func (a *api) listFolders(limit float64, parentID, query string) ([]file, error) {
	parts := []string{"mimeType = '" + folderMimeType + "'", "trashed = false"}
	if parentID != "" {
		parts = append(parts, "'"+parentID+"' in parents")
	}
	if query != "" {
		parts = append(parts, query)
	}
	return a.list(listOptions{limit: limit, query: strings.Join(parts, " and "), orderBy: "name"})
}

func (a *api) search(query, mimeType string, limit float64, folderID string) ([]file, error) {
	parts := []string{"trashed = false", "fullText contains '" + strings.ReplaceAll(query, "'", `\'`) + "'"}
	if mimeType != "" {
		parts = append(parts, "mimeType = '"+mimeType+"'")
	}
	if folderID != "" {
		parts = append(parts, "'"+folderID+"' in parents")
	}
	return a.list(listOptions{limit: limit, query: strings.Join(parts, " and "), orderBy: "modifiedTime desc"})
}

func (a *api) get(fileIDOrURL string) (*file, error) {
	f, err := a.svc.Files.Get(extractFileID(fileIDOrURL)).Fields(fileFields).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("get file", err)
	}
	out := parseFile(f)
	return &out, nil
}

func supportedFormats(mimeType string) string {
	var names []string
	for _, f := range exportFormats[mimeType] {
		names = append(names, f.format)
	}
	return strings.Join(names, ", ")
}

func exportMimeType(mimeType, format string) string {
	for _, f := range exportFormats[mimeType] {
		if f.format == format {
			return f.mimeType
		}
	}
	return ""
}

func workspaceTypeName(mimeType string) string {
	if name, ok := workspaceTypeNames[mimeType]; ok {
		return name
	}
	return "Workspace file"
}

func (a *api) download(fileIDOrURL, outputPath, format string) (*downloaded, error) {
	fileID := extractFileID(fileIDOrURL)
	f, err := a.get(fileID)
	if err != nil {
		return nil, err
	}
	var call interface {
		Download(...googleapi.CallOption) (*http.Response, error)
	}
	mimeType := f.MimeType
	if strings.HasPrefix(f.MimeType, "application/vnd.google-apps.") {
		typeName := workspaceTypeName(f.MimeType)
		if format == "" {
			return nil, a.fail("INVALID_PARAMS", "Cannot download Google "+typeName+" directly", "Use --export with one of: "+supportedFormats(f.MimeType))
		}
		mimeType = exportMimeType(f.MimeType, format)
		if mimeType == "" {
			return nil, a.fail("INVALID_PARAMS", "Cannot export Google "+typeName+" to "+format, "Supported formats: "+supportedFormats(f.MimeType))
		}
		call = a.svc.Files.Export(fileID, mimeType).Context(a.ctx)
	} else {
		if format != "" {
			return nil, a.fail("INVALID_PARAMS", "Export format is only for Google Workspace files", "Remove --export flag for regular files")
		}
		call = a.svc.Files.Get(fileID).Context(a.ctx)
	}
	resp, err := call.Download()
	if err != nil {
		return nil, a.apiError("download file", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, a.apiError("download file", err)
	}
	if err := os.WriteFile(outputPath, body, 0o666); err != nil {
		return nil, a.apiError("download file", google.NodeFSError("open", outputPath, err))
	}
	return &downloaded{Filename: f.Name, Path: outputPath, Size: int64(len(body)), MimeType: mimeType}, nil
}

var lastExtension = regexp.MustCompile(`\.[^.]+$`)

func (a *api) upload(filePath, name, folderID, mimeType string, convert bool) (*uploaded, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, a.apiError("upload file", google.NodeFSError("stat", filePath, err))
	}
	fileName := name
	if fileName == "" {
		fileName = filepath.Base(filePath)
	}
	ext := strings.ToLower(google.Extname(filePath))
	sourceMimeType := mimeType
	if sourceMimeType == "" {
		sourceMimeType = extToMime[ext]
	}
	if sourceMimeType == "" {
		sourceMimeType = "application/octet-stream"
	}
	target := &drive.File{Name: fileName}
	if convert {
		target.MimeType = convertibleMimeTypes[sourceMimeType]
		if target.MimeType == "" {
			what := ext
			if what == "" {
				what = "this file type"
			}
			return nil, a.fail("INVALID_PARAMS", "Cannot convert "+what+" to Google Workspace format",
				"Supported: docx, doc, odt, txt, html, rtf, xlsx, xls, ods, csv, tsv, pptx, ppt, odp")
		}
		// The extension is dropped when converting.
		target.Name = lastExtension.ReplaceAllString(fileName, "")
	}
	target.ForceSendFields = []string{"Name"}
	if folderID != "" {
		target.Parents = []string{folderID}
	}
	if info.IsDir() {
		return nil, a.apiError("upload file", google.NodeFSError("read", "", syscall.EISDIR))
	}
	body, err := os.Open(filePath)
	if err != nil {
		return nil, a.apiError("upload file", google.NodeFSError("open", filePath, err))
	}
	defer body.Close()
	// ChunkSize(0) sends one multipart request whatever the size, as Bun does.
	f, err := a.svc.Files.Create(target).
		Media(body, googleapi.ContentType(sourceMimeType), googleapi.ChunkSize(0)).
		Fields("id,name,mimeType,size,webViewLink").Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("upload file", err)
	}
	out := &uploaded{ID: f.Id, Name: f.Name, MimeType: f.MimeType, Size: info.Size(), WebViewLink: f.WebViewLink}
	if out.Name == "" {
		out.Name = fileName
	}
	if out.MimeType == "" {
		out.MimeType = sourceMimeType
	}
	return out, nil
}

func (a *api) copy(fileIDOrURL, name, folderID string) (*copied, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	body := &drive.File{Name: name}
	if folderID != "" {
		body.Parents = []string{folderID}
	}
	f, err := a.svc.Files.Copy(extractFileID(fileIDOrURL), body).SupportsAllDrives(true).
		Fields("id,name,mimeType,parents,webViewLink").Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("copy file", err)
	}
	out := &copied{ID: f.Id, Name: f.Name, MimeType: f.MimeType, Parents: f.Parents, WebViewLink: f.WebViewLink}
	if out.Name == "" {
		out.Name = "Untitled"
	}
	if out.MimeType == "" {
		out.MimeType = "application/octet-stream"
	}
	return out, nil
}

// update is files.update with supportsAllDrives and the full file fields.
func (a *api) update(operation string, call *drive.FilesUpdateCall) (*file, error) {
	f, err := call.SupportsAllDrives(true).Fields(fileFields).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError(operation, err)
	}
	out := parseFile(f)
	return &out, nil
}

func (a *api) trash(fileIDOrURL string) (*file, error) {
	return a.update("trash file", a.svc.Files.Update(extractFileID(fileIDOrURL), &drive.File{Trashed: true}))
}

func (a *api) rename(fileIDOrURL, name string) (*file, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	body := &drive.File{Name: name, ForceSendFields: []string{"Name"}}
	return a.update("rename file", a.svc.Files.Update(extractFileID(fileIDOrURL), body))
}

func (a *api) move(fileIDOrURL, folderIDOrURL string) (*file, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	fileID, folderID := extractFileID(fileIDOrURL), extractFileID(folderIDOrURL)
	current, err := a.svc.Files.Get(fileID).SupportsAllDrives(true).Fields("parents").Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("move file", err)
	}
	call := a.svc.Files.Update(fileID, &drive.File{}).AddParents(folderID)
	if previous := strings.Join(current.Parents, ","); previous != "" {
		call = call.RemoveParents(previous)
	}
	return a.update("move file", call)
}

func (a *api) mkdir(name, parentIDOrURL string) (*file, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	body := &drive.File{Name: name, MimeType: folderMimeType, ForceSendFields: []string{"Name"}}
	if parentIDOrURL != "" {
		body.Parents = []string{extractFileID(parentIDOrURL)}
	}
	f, err := a.svc.Files.Create(body).SupportsAllDrives(true).Fields(fileFields).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("create folder", err)
	}
	out := parseFile(f)
	return &out, nil
}

func (a *api) permissions(fileIDOrURL string) ([]permission, error) {
	resp, err := a.svc.Permissions.List(extractFileID(fileIDOrURL)).SupportsAllDrives(true).
		Fields("permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery)").Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("list permissions", err)
	}
	out := []permission{}
	for _, p := range resp.Permissions {
		out = append(out, permission{
			ID: p.Id, Type: p.Type, Role: p.Role, EmailAddress: p.EmailAddress,
			Domain: p.Domain, DisplayName: p.DisplayName, AllowFileDiscovery: p.AllowFileDiscovery,
		})
	}
	return out, nil
}

type shareOptions struct {
	kind, role, emailAddress, domain, emailMessage string
	notify, allowFileDiscovery                     bool
}

// share is GDriveClient.share. Google rejects allowFileDiscovery on anything
// but type=anyone, so it is only sent there (false included).
func (a *api) share(fileIDOrURL, printedID string, o shareOptions) (*shared, error) {
	if o.role == "" {
		o.role = "reader"
	}
	body := &drive.Permission{Type: o.kind, Role: o.role, EmailAddress: o.emailAddress, Domain: o.domain}
	if o.kind == "anyone" {
		body.AllowFileDiscovery = o.allowFileDiscovery
		body.ForceSendFields = []string{"AllowFileDiscovery"}
	}
	call := a.svc.Permissions.Create(extractFileID(fileIDOrURL), body).SupportsAllDrives(true).
		SendNotificationEmail(o.notify).Fields("id,type,role,emailAddress,domain")
	if o.emailMessage != "" {
		call = call.EmailMessage(o.emailMessage)
	}
	p, err := call.Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("share file", err)
	}
	return &shared{PermissionID: p.Id, Type: p.Type, Role: p.Role, EmailAddress: p.EmailAddress, Domain: p.Domain, FileID: printedID}, nil
}

func (a *api) unshare(fileIDOrURL, permissionID string) error {
	if err := a.svc.Permissions.Delete(extractFileID(fileIDOrURL), permissionID).SupportsAllDrives(true).Context(a.ctx).Do(); err != nil {
		return a.apiError("remove permission", err)
	}
	return nil
}
