package gdrive

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	drive "google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
)

const (
	folderMimeType = "application/vnd.google-apps.folder"
	fileFields     = "id,name,mimeType,size,createdTime,modifiedTime,owners,parents,webViewLink,webContentLink,starred,trashed,shared,description"
)

// The models are the Bun client's objects (GDriveFile, GDriveUploadResult,
// GDriveCopyResult, GDrivePermission, GDriveShareResult), built from the
// answer as JavaScript reads it (google.Answer): a field the answer lacks is
// undefined, and a null item fails with Bun's TypeError.

// fileList is a list result with the printGDriveFileList title; --json
// prints the files alone.
type fileList struct {
	Title string
	Files []any
}

func (l fileList) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(l.Files), nil }

// downloaded is GDriveDownloadResult.
type downloaded struct {
	Filename any    `json:"filename"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	MimeType any    `json:"mimeType"`
}

func (d *downloaded) MarshalJSON() ([]byte, error) {
	return jsvalue.Stringify(jsvalue.ObjectOf("filename", d.Filename, "path", d.Path, "size", d.Size, "mimeType", d.MimeType)), nil
}

// shared is GDriveShareResult (Result) with the id printGDriveShared puts in
// the public URL.
type shared struct {
	Result *jsvalue.Object
	FileID string
}

func (s *shared) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(s.Result), nil }

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
	google.API
	svc         *drive.Service
	accessLevel string
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	svc, err := google.DriveService(ctx, run)
	if err != nil {
		return nil, err
	}
	level, _ := run.Credentials.Value("accessLevel").(string)
	return &api{API: google.API{Ctx: ctx, RunContext: run, ErrorMessage: errorMessage}, svc: svc, accessLevel: level}, nil
}

// errorMessage is GDriveClient.getErrorMessage. Unlike the other Google
// clients, gdrive prefers the API's own message and uses the fixed status
// text only when that message is blank.
func errorMessage(err error) string {
	if message := google.Message(err); jsvalue.Trim(message) != "" {
		return message
	}
	return google.StatusMessage(err, "Insufficient permissions to access this file", "File not found")
}

// assertWriteAccess treats a missing accessLevel as readonly, as Bun does.
func (a *api) assertWriteAccess() error {
	if a.accessLevel == "" || a.accessLevel == "readonly" {
		return a.Fail("PERMISSION_DENIED", "This profile has read-only access", "Create a new profile with full access: agentio gdrive profile add --full")
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

// parseFile is Bun parseFile.
func parseFile(f any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(f) {
		return nil, jsvalue.TypeError(f, "file.id")
	}
	get := func(k string) any { return jsvalue.Member(f, k) }
	opt := func(k string) any { return jsvalue.Or(get(k), jsvalue.Undefined) }
	size := jsvalue.Undefined
	if jsvalue.Truthy(get("size")) {
		size = jsvalue.ParseInt(jsvalue.String(get("size")))
	}
	owners := jsvalue.Undefined
	if raw := get("owners"); !jsvalue.Nullish(raw) {
		items, err := jsvalue.Items(raw, "file.owners?")
		if err != nil {
			return nil, err
		}
		names := []any{}
		for _, o := range items {
			if jsvalue.Nullish(o) {
				return nil, jsvalue.TypeError(o, "o.displayName")
			}
			names = append(names, jsvalue.Or(jsvalue.Or(jsvalue.Member(o, "displayName"), jsvalue.Member(o, "emailAddress")), "Unknown"))
		}
		owners = names
	}
	return jsvalue.ObjectOf(
		"id", get("id"),
		"name", jsvalue.Or(get("name"), "Untitled"),
		"mimeType", jsvalue.Or(get("mimeType"), "application/octet-stream"),
		"size", size,
		"createdTime", opt("createdTime"),
		"modifiedTime", opt("modifiedTime"),
		"owners", owners,
		"parents", opt("parents"),
		"webViewLink", opt("webViewLink"),
		"webContentLink", opt("webContentLink"),
		"starred", jsvalue.Or(get("starred"), false),
		"trashed", jsvalue.Or(get("trashed"), false),
		"shared", jsvalue.Or(get("shared"), false),
		"description", opt("description"),
	), nil
}

// answerFile is `this.parseFile(response.data)` inside a client method's
// try: a failure, the call's or parseFile's, is "Failed to <operation>".
func answerFile[C google.Call[C, *drive.File]](a *api, operation string, call C) (*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, call)
	if err != nil {
		return nil, a.Failed(operation, err)
	}
	f, err := parseFile(raw)
	if err != nil {
		return nil, a.Failed(operation, err)
	}
	return f, nil
}

type listOptions struct {
	limit        float64
	folderID     string
	query        string
	orderBy      string
	includeTrash bool
}

// list pages through files.list until limit files are collected.
func (a *api) list(o listOptions) ([]any, error) {
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
	all := []any{}
	pageToken := jsvalue.Undefined
	for {
		call := a.svc.Files.List().Fields("nextPageToken,files(" + fileFields + ")").OrderBy(o.orderBy)
		if q != "" {
			call = call.Q(q)
		}
		if pageToken != jsvalue.Undefined {
			call = call.PageToken(jsvalue.String(pageToken))
		}
		_, raw, err := google.Answer(a.Ctx, call, google.PageSize(o.limit-float64(len(all))))
		if err == nil {
			err = a.appendFiles(&all, raw)
		}
		if err != nil {
			return nil, a.Failed("list files", err)
		}
		pageToken = jsvalue.Or(jsvalue.Member(raw, "nextPageToken"), jsvalue.Undefined)
		if !jsvalue.Truthy(pageToken) || !(float64(len(all)) < o.limit) {
			break
		}
	}
	return all[:sliceEnd(o.limit, len(all))], nil
}

// appendFiles is `allFiles.push(...(response.data.files || []).map(this.parseFile))`.
func (a *api) appendFiles(all *[]any, raw any) error {
	files, err := jsvalue.Path(raw, "response.data", "files")
	if err != nil {
		return err
	}
	items, err := jsvalue.Items(jsvalue.Or(files, []any{}), "(response.data.files || [])")
	if err != nil {
		return err
	}
	for _, item := range items {
		f, err := parseFile(item)
		if err != nil {
			return err
		}
		*all = append(*all, f)
	}
	return nil
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

func (a *api) listFolders(limit float64, parentID, query string) ([]any, error) {
	parts := []string{"mimeType = '" + folderMimeType + "'", "trashed = false"}
	if parentID != "" {
		parts = append(parts, "'"+parentID+"' in parents")
	}
	if query != "" {
		parts = append(parts, query)
	}
	return a.list(listOptions{limit: limit, query: strings.Join(parts, " and "), orderBy: "name"})
}

func (a *api) search(query, mimeType string, limit float64, folderID string) ([]any, error) {
	parts := []string{"trashed = false", "fullText contains '" + strings.ReplaceAll(query, "'", `\'`) + "'"}
	if mimeType != "" {
		parts = append(parts, "mimeType = '"+mimeType+"'")
	}
	if folderID != "" {
		parts = append(parts, "'"+folderID+"' in parents")
	}
	return a.list(listOptions{limit: limit, query: strings.Join(parts, " and "), orderBy: "modifiedTime desc"})
}

func (a *api) get(fileIDOrURL string) (*jsvalue.Object, error) {
	return answerFile(a, "get file", a.svc.Files.Get(extractFileID(fileIDOrURL)).Fields(fileFields))
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
	fileMime := jsvalue.String(f.Value("mimeType"))
	mimeType := f.Value("mimeType")
	if strings.HasPrefix(fileMime, "application/vnd.google-apps.") {
		typeName := workspaceTypeName(fileMime)
		if format == "" {
			return nil, a.Fail("INVALID_PARAMS", "Cannot download Google "+typeName+" directly", "Use --export with one of: "+supportedFormats(fileMime))
		}
		exportMime := exportMimeType(fileMime, format)
		if exportMime == "" {
			return nil, a.Fail("INVALID_PARAMS", "Cannot export Google "+typeName+" to "+format, "Supported formats: "+supportedFormats(fileMime))
		}
		mimeType = exportMime
		call = a.svc.Files.Export(fileID, exportMime).Context(a.Ctx)
	} else {
		if format != "" {
			return nil, a.Fail("INVALID_PARAMS", "Export format is only for Google Workspace files", "Remove --export flag for regular files")
		}
		call = a.svc.Files.Get(fileID).Context(a.Ctx)
	}
	resp, err := call.Download()
	if err != nil {
		return nil, a.Failed("download file", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, a.Failed("download file", err)
	}
	if err := nodefs.WriteFile(outputPath, body); err != nil {
		return nil, a.Failed("download file", err)
	}
	return &downloaded{Filename: f.Value("name"), Path: outputPath, Size: int64(len(body)), MimeType: mimeType}, nil
}

var lastExtension = regexp.MustCompile(`\.[^.]+$`)

func (a *api) upload(filePath, name, folderID, mimeType string, convert bool) (*jsvalue.Object, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, a.Failed("upload file", nodefs.NodeFSError("stat", filePath, err))
	}
	fileName := name
	if fileName == "" {
		fileName = filepath.Base(filePath)
	}
	ext := strings.ToLower(nodefs.Extname(filePath))
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
			return nil, a.Fail("INVALID_PARAMS", "Cannot convert "+what+" to Google Workspace format",
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
		return nil, a.Failed("upload file", nodefs.NodeFSError("read", "", syscall.EISDIR))
	}
	body, err := os.Open(filePath)
	if err != nil {
		return nil, a.Failed("upload file", nodefs.NodeFSError("open", filePath, err))
	}
	defer body.Close()
	// ChunkSize(0) sends one multipart request whatever the size, as Bun does.
	_, raw, err := google.Answer(a.Ctx, a.svc.Files.Create(target).
		Media(body, googleapi.ContentType(sourceMimeType), googleapi.ChunkSize(0)).
		Fields("id,name,mimeType,size,webViewLink"))
	if err == nil && jsvalue.Nullish(raw) {
		err = jsvalue.TypeError(raw, "response.data.id")
	}
	if err != nil {
		return nil, a.Failed("upload file", err)
	}
	get := func(k string) any { return jsvalue.Member(raw, k) }
	return jsvalue.ObjectOf(
		"id", get("id"),
		"name", jsvalue.Or(get("name"), fileName),
		"mimeType", jsvalue.Or(get("mimeType"), sourceMimeType),
		"size", info.Size(),
		"webViewLink", jsvalue.Or(get("webViewLink"), jsvalue.Undefined),
	), nil
}

func (a *api) copy(fileIDOrURL, name, folderID string) (*jsvalue.Object, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	body := &drive.File{Name: name}
	if folderID != "" {
		body.Parents = []string{folderID}
	}
	_, raw, err := google.Answer(a.Ctx, a.svc.Files.Copy(extractFileID(fileIDOrURL), body).SupportsAllDrives(true).
		Fields("id,name,mimeType,parents,webViewLink"))
	if err == nil && jsvalue.Nullish(raw) {
		err = jsvalue.TypeError(raw, "response.data.id")
	}
	if err != nil {
		return nil, a.Failed("copy file", err)
	}
	get := func(k string) any { return jsvalue.Member(raw, k) }
	return jsvalue.ObjectOf(
		"id", get("id"),
		"name", jsvalue.Or(get("name"), "Untitled"),
		"mimeType", jsvalue.Or(get("mimeType"), "application/octet-stream"),
		"parents", jsvalue.Or(get("parents"), jsvalue.Undefined),
		"webViewLink", jsvalue.Or(get("webViewLink"), jsvalue.Undefined),
	), nil
}

// update is files.update with supportsAllDrives and the full file fields.
func (a *api) update(operation string, call *drive.FilesUpdateCall) (*jsvalue.Object, error) {
	return answerFile(a, operation, call.SupportsAllDrives(true).Fields(fileFields))
}

func (a *api) trash(fileIDOrURL string) (*jsvalue.Object, error) {
	return a.update("trash file", a.svc.Files.Update(extractFileID(fileIDOrURL), &drive.File{Trashed: true}))
}

func (a *api) rename(fileIDOrURL, name string) (*jsvalue.Object, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	body := &drive.File{Name: name, ForceSendFields: []string{"Name"}}
	return a.update("rename file", a.svc.Files.Update(extractFileID(fileIDOrURL), body))
}

func (a *api) move(fileIDOrURL, folderIDOrURL string) (*jsvalue.Object, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	fileID, folderID := extractFileID(fileIDOrURL), extractFileID(folderIDOrURL)
	_, current, err := google.Answer(a.Ctx, a.svc.Files.Get(fileID).SupportsAllDrives(true).Fields("parents"))
	var parents any
	if err == nil {
		// Bun reports this expression as its own transpiled source text.
		parents, err = jsvalue.Path(current, "current.data", "parents")
	}
	if err != nil {
		return nil, a.Failed("move file", err)
	}
	previous := ""
	if list, ok := jsvalue.Or(parents, []any{}).([]any); ok {
		previous = jsvalue.Join(list, ",")
	}
	call := a.svc.Files.Update(fileID, &drive.File{}).AddParents(folderID)
	if previous != "" {
		call = call.RemoveParents(previous)
	}
	return a.update("move file", call)
}

func (a *api) mkdir(name, parentIDOrURL string) (*jsvalue.Object, error) {
	if err := a.assertWriteAccess(); err != nil {
		return nil, err
	}
	body := &drive.File{Name: name, MimeType: folderMimeType, ForceSendFields: []string{"Name"}}
	if parentIDOrURL != "" {
		body.Parents = []string{extractFileID(parentIDOrURL)}
	}
	return answerFile(a, "create folder", a.svc.Files.Create(body).SupportsAllDrives(true).Fields(fileFields))
}

func (a *api) permissions(fileIDOrURL string) ([]any, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Permissions.List(extractFileID(fileIDOrURL)).SupportsAllDrives(true).
		Fields("permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery)"))
	var out []any
	if err == nil {
		out, err = parsePermissions(raw)
	}
	if err != nil {
		return nil, a.Failed("list permissions", err)
	}
	return out, nil
}

// parsePermissions is `(response.data.permissions || []).map(...)` into
// GDrivePermission objects. Bun reports a null answer with its own
// transpiled source text.
func parsePermissions(raw any) ([]any, error) {
	list, err := jsvalue.Path(raw, "response.data", "permissions")
	if err != nil {
		return nil, err
	}
	items, err := jsvalue.Items(jsvalue.Or(list, []any{}), "(response.data.permissions || [])")
	if err != nil {
		return nil, err
	}
	out := []any{}
	for _, p := range items {
		if jsvalue.Nullish(p) {
			return nil, jsvalue.TypeError(p, "p.id")
		}
		get := func(k string) any { return jsvalue.Member(p, k) }
		discovery := get("allowFileDiscovery")
		if jsvalue.Nullish(discovery) {
			discovery = jsvalue.Undefined
		}
		out = append(out, jsvalue.ObjectOf(
			"id", get("id"),
			"type", get("type"),
			"role", get("role"),
			"emailAddress", jsvalue.Or(get("emailAddress"), jsvalue.Undefined),
			"domain", jsvalue.Or(get("domain"), jsvalue.Undefined),
			"displayName", jsvalue.Or(get("displayName"), jsvalue.Undefined),
			"allowFileDiscovery", discovery,
		))
	}
	return out, nil
}

type shareOptions struct {
	kind, role, emailAddress, domain string
	// emailMessage is nil when absent; googleapis sends a given "" empty.
	emailMessage               *string
	notify, allowFileDiscovery bool
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
	if o.emailMessage != nil {
		call = call.EmailMessage(*o.emailMessage)
	}
	_, raw, err := google.Answer(a.Ctx, call)
	if err == nil && jsvalue.Nullish(raw) {
		err = jsvalue.TypeError(raw, "response.data.id")
	}
	if err != nil {
		return nil, a.Failed("share file", err)
	}
	get := func(k string) any { return jsvalue.Member(raw, k) }
	return &shared{Result: jsvalue.ObjectOf(
		"permissionId", get("id"),
		"type", get("type"),
		"role", get("role"),
		"emailAddress", jsvalue.Or(get("emailAddress"), jsvalue.Undefined),
		"domain", jsvalue.Or(get("domain"), jsvalue.Undefined),
	), FileID: printedID}, nil
}

// unshare is GDriveClient.unshare. googleapis refuses an undefined
// permissionId before sending anything, and puts null in the path as "".
func (a *api) unshare(fileIDOrURL string, permissionID any) error {
	if permissionID == jsvalue.Undefined {
		return a.Failed("remove permission", errors.New("Missing required parameters: permissionId"))
	}
	id := ""
	if permissionID != nil {
		id = jsvalue.String(permissionID)
	}
	if err := a.svc.Permissions.Delete(extractFileID(fileIDOrURL), id).SupportsAllDrives(true).Context(a.Ctx).Do(); err != nil {
		return a.Failed("remove permission", err)
	}
	return nil
}
