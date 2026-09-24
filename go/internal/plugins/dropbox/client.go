package dropbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

const (
	rpcBase     = "https://api.dropboxapi.com/2"
	contentBase = "https://content.dropboxapi.com/2"
	// maxPageSize is the per-call ceiling imposed by files/list_folder.
	maxPageSize = 2000
	// maxPages guards against unbounded paging when a filter matches very little.
	maxPages = 50
)

var (
	// singleUploadLimit caps single-request uploads; larger files go through a session.
	singleUploadLimit int64 = 150 * 1024 * 1024
	// uploadChunkSize is a multiple of 4 MiB, as Dropbox recommends.
	uploadChunkSize = 8 * 1024 * 1024
)

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

// apiError is Bun's CliError thrown by the client. Commands hand it to Fail.
type apiError struct {
	code       plugins.ErrorCode
	message    string
	suggestion string
}

func (e *apiError) Error() string { return e.message }

// failed turns a client error into the host error Bun's handleError prints.
func failed(fail func(plugins.ErrorCode, string, string) error, err error) error {
	if ae, ok := err.(*apiError); ok {
		return fail(ae.code, ae.message, ae.suggestion)
	}
	return err
}

type rawMetadata struct {
	Tag            string  `json:".tag"`
	ID             string  `json:"id"`
	Name           string  `json:"name"`
	PathDisplay    string  `json:"path_display"`
	PathLower      string  `json:"path_lower"`
	Size           *int64  `json:"size"`
	ServerModified *string `json:"server_modified"`
	Rev            *string `json:"rev"`
	ContentHash    *string `json:"content_hash"`
}

// entry is DropboxEntry. Pointers keep Bun's "undefined is omitted, empty is kept".
type entry struct {
	Type        string  `json:"type"`
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Path        string  `json:"path"`
	Size        *int64  `json:"size,omitempty"`
	Modified    *string `json:"modified,omitempty"`
	Rev         *string `json:"rev,omitempty"`
	ContentHash *string `json:"contentHash,omitempty"`
}

// entryList carries the heading Bun prints above a listing. JSON is the entries.
type entryList struct {
	title   string
	entries []entry
}

func (l entryList) MarshalJSON() ([]byte, error) {
	if l.entries == nil {
		return []byte("[]"), nil
	}
	return marshal(l.entries)
}

type uploadResult struct {
	ID   string  `json:"id"`
	Name string  `json:"name"`
	Path string  `json:"path"`
	Size int64   `json:"size"`
	Rev  *string `json:"rev,omitempty"`
}

type downloadResult struct {
	Path       string `json:"path"`
	OutputPath string `json:"outputPath"`
	Size       int64  `json:"size"`
	Kind       string `json:"kind"`
}

type account struct {
	AccountID     string  `json:"accountId"`
	Name          string  `json:"name"`
	Email         string  `json:"email"`
	EmailVerified bool    `json:"emailVerified"`
	AccountType   string  `json:"accountType"`
	Country       *string `json:"country,omitempty"`
}

type link struct {
	URL  string `json:"url"`
	Path string `json:"path"`
	Kind string `json:"kind"`
}

func mapEntry(raw rawMetadata) entry {
	typ := "file"
	switch raw.Tag {
	case "folder":
		typ = "folder"
	case "deleted":
		typ = "deleted"
	}
	path := raw.PathDisplay
	if path == "" {
		path = raw.PathLower
	}
	return entry{
		Type: typ, ID: raw.ID, Name: raw.Name, Path: path,
		Size: raw.Size, Modified: raw.ServerModified, Rev: raw.Rev, ContentHash: raw.ContentHash,
	}
}

// marshal is JSON.stringify: no HTML escaping and no trailing newline.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// headerSafeJSON escapes every UTF-16 unit from U+007F up, because
// Dropbox-API-Arg travels in an ASCII-only HTTP header.
func headerSafeJSON(v any) (string, error) {
	raw, err := marshal(v)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, r := range string(raw) {
		if r < 0x7f {
			b.WriteRune(r)
			continue
		}
		for _, unit := range utf16.Encode([]rune{r}) {
			fmt.Fprintf(&b, "\\u%04x", unit)
		}
	}
	return b.String(), nil
}

var identifierPath = regexp.MustCompile(`^(id|rev|ns):`)

// normalizePath is normalizeDropboxPath: the root is "", everything else is
// absolute with no trailing slash, and id:/rev:/ns: identifiers pass through.
func normalizePath(input string) string {
	trimmed := jsvalue.Trim(input)
	if trimmed == "" || trimmed == "/" {
		return ""
	}
	if identifierPath.MatchString(trimmed) {
		return trimmed
	}
	withSlash := trimmed
	if !strings.HasPrefix(withSlash, "/") {
		withSlash = "/" + withSlash
	}
	if len(withSlash) > 1 {
		return strings.TrimRight(withSlash, "/")
	}
	return withSlash
}

func statusCode(status int) plugins.ErrorCode {
	switch status {
	case http.StatusUnauthorized:
		return "AUTH_FAILED"
	case http.StatusForbidden:
		return "PERMISSION_DENIED"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusTooManyRequests:
		return "RATE_LIMITED"
	default:
		return "API_ERROR"
	}
}

// errorCodeFor reads the 409 error_summary, which says more than the status.
func errorCodeFor(status int, summary string) plugins.ErrorCode {
	if status == http.StatusConflict {
		switch {
		case strings.Contains(summary, "not_found"):
			return "NOT_FOUND"
		case strings.Contains(summary, "conflict"), strings.Contains(summary, "malformed_path"):
			return "INVALID_PARAMS"
		case strings.Contains(summary, "insufficient_space"):
			return "API_ERROR"
		case strings.Contains(summary, "no_write_permission"):
			return "PERMISSION_DENIED"
		}
		return "API_ERROR"
	}
	return statusCode(status)
}

func suggestionFor(status int, summary string) string {
	switch {
	case status == http.StatusUnauthorized:
		return "Run: agentio dropbox profile add to re-authorise"
	case status == http.StatusTooManyRequests:
		return "Dropbox is rate limiting this app - wait a moment and retry"
	case strings.Contains(summary, "conflict"):
		return "A file already exists at that path - pass --overwrite to replace it"
	case strings.Contains(summary, "missing_scope"):
		return "Enable the missing permission in the Dropbox App Console, then run: agentio dropbox profile add"
	}
	return ""
}

type api struct {
	access string
	ctx    context.Context
	fetch  fetchFunc
}

func newAPI(ctx context.Context, creds map[string]any, fetch fetchFunc) *api {
	return &api{access: str(creds, "accessToken"), ctx: ctx, fetch: fetch}
}

func responseError(resp *http.Response, operation string) error {
	raw, _ := io.ReadAll(resp.Body)
	text := string(raw)
	summary := text
	var parsed struct {
		ErrorSummary string `json:"error_summary"`
	}
	// Dropbox returns plain text for 400 and some 5xx responses.
	if json.Unmarshal(raw, &parsed) == nil && parsed.ErrorSummary != "" {
		summary = parsed.ErrorSummary
	}
	return &apiError{
		code:       errorCodeFor(resp.StatusCode, summary),
		message:    fmt.Sprintf("Dropbox %s failed (%d): %s", operation, resp.StatusCode, jsvalue.Trim(summary)),
		suggestion: suggestionFor(resp.StatusCode, summary),
	}
}

func (a *api) send(url string, headers [][2]string, body []byte) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(a.ctx, http.MethodPost, url, reader)
	if err != nil {
		return nil, &apiError{code: "NETWORK_ERROR", message: "Could not reach the Dropbox API: " + err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+a.access)
	for _, h := range headers {
		req.Header.Set(h[0], h[1])
	}
	resp, err := a.fetch(a.ctx, req)
	if err != nil {
		return nil, &apiError{code: "NETWORK_ERROR", message: "Could not reach the Dropbox API: " + err.Error()}
	}
	return resp, nil
}

func decodeBody(resp *http.Response, out any) error {
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if len(raw) == 0 || out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// rpc is a JSON-in, JSON-out call against api.dropboxapi.com.
func (a *api) rpc(endpoint string, args any, out any) error {
	body, err := marshal(args)
	if err != nil {
		return err
	}
	resp, err := a.send(rpcBase+"/"+endpoint, [][2]string{{"Content-Type", "application/json"}}, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return responseError(resp, endpoint)
	}
	return decodeBody(resp, out)
}

// downloadContent is a binary-out call; the arguments ride in a header.
func (a *api) downloadContent(endpoint string, args any) ([]byte, error) {
	arg, err := headerSafeJSON(args)
	if err != nil {
		return nil, err
	}
	resp, err := a.send(contentBase+"/"+endpoint, [][2]string{{"Dropbox-API-Arg", arg}}, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, responseError(resp, endpoint)
	}
	return io.ReadAll(resp.Body)
}

// uploadContent is a binary-in call against content.dropboxapi.com.
func (a *api) uploadContent(endpoint string, args any, body []byte, out any) error {
	arg, err := headerSafeJSON(args)
	if err != nil {
		return err
	}
	resp, err := a.send(contentBase+"/"+endpoint, [][2]string{
		{"Dropbox-API-Arg", arg},
		{"Content-Type", "application/octet-stream"},
	}, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return responseError(resp, endpoint)
	}
	return decodeBody(resp, out)
}

func (a *api) account() (account, error) {
	var raw struct {
		AccountID string `json:"account_id"`
		Name      *struct {
			DisplayName string `json:"display_name"`
		} `json:"name"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		AccountType   *struct {
			Tag string `json:".tag"`
		} `json:"account_type"`
		Country *string `json:"country"`
	}
	if err := a.rpc("users/get_current_account", nil, &raw); err != nil {
		return account{}, err
	}
	out := account{AccountID: raw.AccountID, Email: raw.Email, EmailVerified: raw.EmailVerified, AccountType: "unknown", Country: raw.Country}
	if raw.Name != nil {
		out.Name = raw.Name.DisplayName
	}
	if raw.AccountType != nil && raw.AccountType.Tag != "" {
		out.AccountType = raw.AccountType.Tag
	}
	return out, nil
}

type listFolderPage struct {
	Entries []rawMetadata `json:"entries"`
	Cursor  string        `json:"cursor"`
	HasMore bool          `json:"has_more"`
}

func clamp(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func (a *api) list(path string, limit int, recursive, foldersOnly bool) ([]entry, error) {
	keep := func(raws []rawMetadata, into []entry) []entry {
		for _, raw := range raws {
			e := mapEntry(raw)
			if !foldersOnly || e.Type == "folder" {
				into = append(into, e)
			}
		}
		return into
	}
	var page listFolderPage
	err := a.rpc("files/list_folder", struct {
		Path                        string `json:"path"`
		Recursive                   bool   `json:"recursive"`
		Limit                       int    `json:"limit"`
		IncludeDeleted              bool   `json:"include_deleted"`
		IncludeNonDownloadableFiles bool   `json:"include_non_downloadable_files"`
	}{normalizePath(path), recursive, clamp(limit, 1, maxPageSize), false, true}, &page)
	if err != nil {
		return nil, err
	}
	entries := keep(page.Entries, []entry{})
	for i := 0; page.HasMore && len(entries) < limit && i < maxPages; i++ {
		cursor := page.Cursor
		page = listFolderPage{}
		if err := a.rpc("files/list_folder/continue", map[string]string{"cursor": cursor}, &page); err != nil {
			return nil, err
		}
		entries = keep(page.Entries, entries)
	}
	if len(entries) > limit {
		entries = entries[:limit]
	}
	return entries, nil
}

type pathArg struct {
	Path string `json:"path"`
}

func (a *api) get(path string) (entry, error) {
	var raw rawMetadata
	if err := a.rpc("files/get_metadata", pathArg{normalizePath(path)}, &raw); err != nil {
		return entry{}, err
	}
	return mapEntry(raw), nil
}

func (a *api) search(query, path string, limit int, filenameOnly bool) ([]entry, error) {
	type searchOptions struct {
		Path         string `json:"path"`
		MaxResults   int    `json:"max_results"`
		FilenameOnly bool   `json:"filename_only"`
	}
	var resp struct {
		Matches []struct {
			Metadata *struct {
				Metadata *rawMetadata `json:"metadata"`
			} `json:"metadata"`
		} `json:"matches"`
	}
	err := a.rpc("files/search_v2", struct {
		Query   string        `json:"query"`
		Options searchOptions `json:"options"`
	}{query, searchOptions{normalizePath(path), clamp(limit, 1, 1000), filenameOnly}}, &resp)
	if err != nil {
		return nil, err
	}
	out := []entry{}
	for _, m := range resp.Matches {
		if m.Metadata != nil && m.Metadata.Metadata != nil {
			out = append(out, mapEntry(*m.Metadata.Metadata))
		}
	}
	return out, nil
}

// download writes a file as-is and a folder as a zip archive, the only way the
// API hands over a whole tree in one call.
func (a *api) download(path, outputPath string) (downloadResult, error) {
	remote := normalizePath(path)
	if remote == "" {
		return downloadResult{}, &apiError{code: "INVALID_PARAMS", message: "Cannot download the account root",
			suggestion: "Give a path, e.g. agentio dropbox download /Documents"}
	}
	e, err := a.get(remote)
	if err != nil {
		return downloadResult{}, err
	}
	isFolder := e.Type == "folder"
	target := outputPath
	if target == "" {
		target = e.Name
		if isFolder {
			target += ".zip"
		}
	}
	endpoint := "files/download"
	if isFolder {
		endpoint = "files/download_zip"
	}
	buf, err := a.downloadContent(endpoint, pathArg{remote})
	if err != nil {
		return downloadResult{}, err
	}
	if err := os.WriteFile(target, buf, 0o666); err != nil {
		return downloadResult{}, err
	}
	kind := "file"
	if isFolder {
		kind = "folder"
	}
	return downloadResult{Path: e.Path, OutputPath: target, Size: int64(len(buf)), Kind: kind}, nil
}

type commitInfo struct {
	Path       string `json:"path"`
	Mode       string `json:"mode"`
	Autorename bool   `json:"autorename"`
	Mute       bool   `json:"mute"`
}

func (a *api) upload(filePath, destination string, overwrite bool) (uploadResult, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return uploadResult{}, &apiError{code: "NOT_FOUND", message: "Local file not found: " + filePath}
	}
	if info.IsDir() {
		return uploadResult{}, &apiError{code: "INVALID_PARAMS", message: `"` + filePath + `" is a directory`,
			suggestion: "Upload files one at a time; the API has no recursive upload"}
	}
	// A destination ending in "/" (or the root) means "keep the local name".
	normalized := normalizePath(destination)
	remote := normalized
	if normalized == "" || strings.HasSuffix(jsvalue.Trim(destination), "/") {
		remote = normalized + "/" + filepath.Base(filePath)
	}
	mode := "add"
	if overwrite {
		mode = "overwrite"
	}
	commit := commitInfo{Path: remote, Mode: mode}
	var raw rawMetadata
	if info.Size() > singleUploadLimit {
		raw, err = a.uploadSession(filePath, info.Size(), commit)
	} else {
		var body []byte
		body, err = os.ReadFile(filePath)
		if err == nil {
			err = a.uploadContent("files/upload", commit, body, &raw)
		}
	}
	if err != nil {
		return uploadResult{}, err
	}
	out := uploadResult{ID: raw.ID, Name: raw.Name, Path: raw.PathDisplay, Size: info.Size(), Rev: raw.Rev}
	if out.Name == "" {
		out.Name = filepath.Base(remote)
	}
	if out.Path == "" {
		out.Path = remote
	}
	if raw.Size != nil {
		out.Size = *raw.Size
	}
	return out, nil
}

// uploadSession is the chunked upload for files above the single-request ceiling.
func (a *api) uploadSession(filePath string, size int64, commit commitInfo) (rawMetadata, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return rawMetadata{}, err
	}
	defer f.Close()
	chunk := make([]byte, uploadChunkSize)
	var offset int64
	readChunk := func() ([]byte, error) {
		n, err := f.ReadAt(chunk, offset)
		if err != nil && err != io.EOF {
			return nil, err
		}
		return chunk[:n], nil
	}
	type cursor struct {
		SessionID string `json:"session_id"`
		Offset    int64  `json:"offset"`
	}
	first, err := readChunk()
	if err != nil {
		return rawMetadata{}, err
	}
	var started struct {
		SessionID string `json:"session_id"`
	}
	if err := a.uploadContent("files/upload_session/start", struct {
		Close bool `json:"close"`
	}{false}, first, &started); err != nil {
		return rawMetadata{}, err
	}
	offset = int64(len(first))
	for offset < size {
		body, err := readChunk()
		if err != nil {
			return rawMetadata{}, err
		}
		if err := a.uploadContent("files/upload_session/append_v2", struct {
			Cursor cursor `json:"cursor"`
			Close  bool   `json:"close"`
		}{cursor{started.SessionID, offset}, false}, body, nil); err != nil {
			return rawMetadata{}, err
		}
		offset += int64(len(body))
	}
	var raw rawMetadata
	err = a.uploadContent("files/upload_session/finish", struct {
		Cursor cursor     `json:"cursor"`
		Commit commitInfo `json:"commit"`
	}{cursor{started.SessionID, offset}, commit}, []byte{}, &raw)
	return raw, err
}

type metadataResponse struct {
	Metadata rawMetadata `json:"metadata"`
}

func (a *api) mkdir(path string) (entry, error) {
	var resp metadataResponse
	if err := a.rpc("files/create_folder_v2", struct {
		Path       string `json:"path"`
		Autorename bool   `json:"autorename"`
	}{normalizePath(path), false}, &resp); err != nil {
		return entry{}, err
	}
	resp.Metadata.Tag = "folder"
	return mapEntry(resp.Metadata), nil
}

func (a *api) relocate(endpoint, from, to string) (entry, error) {
	var resp metadataResponse
	if err := a.rpc(endpoint, struct {
		FromPath   string `json:"from_path"`
		ToPath     string `json:"to_path"`
		Autorename bool   `json:"autorename"`
	}{normalizePath(from), normalizePath(to), false}, &resp); err != nil {
		return entry{}, err
	}
	return mapEntry(resp.Metadata), nil
}

// remove moves to the Dropbox trash, where it stays recoverable.
func (a *api) remove(path string) (entry, error) {
	var resp metadataResponse
	if err := a.rpc("files/delete_v2", pathArg{normalizePath(path)}, &resp); err != nil {
		return entry{}, err
	}
	return mapEntry(resp.Metadata), nil
}

// temporaryLink is a direct download URL that expires after four hours. Files only.
func (a *api) temporaryLink(path string) (link, error) {
	var resp struct {
		Link     string      `json:"link"`
		Metadata rawMetadata `json:"metadata"`
	}
	if err := a.rpc("files/get_temporary_link", pathArg{normalizePath(path)}, &resp); err != nil {
		return link{}, err
	}
	p := resp.Metadata.PathDisplay
	if p == "" {
		p = normalizePath(path)
	}
	return link{URL: resp.Link, Path: p, Kind: "temporary"}, nil
}

// sharedLink returns the existing link when Dropbox refuses to create a second one.
func (a *api) sharedLink(path string) (link, error) {
	remote := normalizePath(path)
	var created struct {
		URL string `json:"url"`
	}
	err := a.rpc("sharing/create_shared_link_with_settings", pathArg{remote}, &created)
	if err == nil {
		return link{URL: created.URL, Path: remote, Kind: "shared"}, nil
	}
	ae, ok := err.(*apiError)
	if !ok || !strings.Contains(ae.message, "shared_link_already_exists") {
		return link{}, err
	}
	var existing struct {
		Links []struct {
			URL string `json:"url"`
		} `json:"links"`
	}
	if lerr := a.rpc("sharing/list_shared_links", struct {
		Path       string `json:"path"`
		DirectOnly bool   `json:"direct_only"`
	}{remote, true}, &existing); lerr != nil {
		return link{}, lerr
	}
	if len(existing.Links) == 0 {
		return link{}, err
	}
	return link{URL: existing.Links[0].URL, Path: remote, Kind: "shared"}, nil
}

func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	acct, err := newAPI(ctx, run.Credentials, run.Fetch).account()
	if err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}, nil
	}
	return plugins.ValidationResult{Valid: true, Info: fmt.Sprintf("%s (%s)", acct.Email, acct.AccountType)}, nil
}
