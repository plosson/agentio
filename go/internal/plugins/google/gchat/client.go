package gchat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	chat "google.golang.org/api/chat/v1"
	"google.golang.org/api/googleapi"
	people "google.golang.org/api/people/v1"
)

// now is the clock behind fallback timestamps and the directory TTL.
var now = time.Now

var attachmentMIME = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".pdf":  "application/pdf",
	".txt":  "text/plain",
	".md":   "text/markdown",
	".csv":  "text/csv",
	".json": "application/json",
	".zip":  "application/zip",
	".mp4":  "video/mp4",
	".mov":  "video/quicktime",
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

// The models are the Bun client's objects (GChatMessage, GChatSpace,
// GChatMember, GChatUser), built from the answers as JavaScript reads them
// (google.Answer for the Chat API, plugins.ResponseJSON for Bun's plain
// fetch calls): fields keep the values the answer gave, a missing one is
// undefined, and a null item fails with Bun's TypeError.

type sendResult struct {
	MessageID     string `json:"messageId"`
	SpaceID       string `json:"spaceId,omitempty"`
	Text          string `json:"text,omitempty"`
	IsJSONPayload bool   `json:"isJsonPayload"`
}

type directoryRefresh struct {
	Size      int    `json:"size"`
	Path      string `json:"path"`
	FetchedAt string `json:"fetchedAt"`
}

// shown is a result that `--format json` prints as JSON.stringify(value).
type shown[T any] struct {
	Value T
	JSON  bool
}

func (s shown[T]) MarshalJSON() ([]byte, error) {
	return stringify(s.Value, "")
}

// resolvedUser is Bun ResolvedUser: the name and email an id resolved to.
type resolvedUser struct {
	displayName any
	email       any
}

type api struct {
	google.API
	chat      *chat.Service
	people    *people.Service
	users     map[string]resolvedUser
	fullUsers map[string]*jsvalue.Object
	dir       *directory
}

func chatService(ctx context.Context, run *plugins.RunContext) (*chat.Service, error) {
	return google.NewService(ctx, run, google.Camel, chat.NewService)
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	chatSvc, err := chatService(ctx, run)
	if err != nil {
		return nil, err
	}
	peopleSvc, err := google.NewService(ctx, run, google.Camel, people.NewService)
	if err != nil {
		return nil, err
	}
	return &api{
		API:  google.API{Ctx: ctx, RunContext: run, ErrorMessage: errorMessage},
		chat: chatSvc, people: peopleSvc, users: map[string]resolvedUser{}, fullUsers: map[string]*jsvalue.Object{},
	}, nil
}

func (a *api) ensureOAuth(operation string) error {
	if isWebhook(a.Credentials) {
		return a.Fail("PERMISSION_DENIED", operation+" is not supported for webhook profiles", "Use an OAuth profile")
	}
	return nil
}

// errorMessage is GChatClient.getErrorMessage.
var errorMessage = google.StatusText("Bot lacks permission for this operation", "Space or message not found")

type sendOptions struct {
	spaceID, text string
	payload       any
	attachments   []string
}

func (a *api) send(o sendOptions) (*sendResult, error) {
	if isWebhook(a.Credentials) {
		if len(o.attachments) > 0 {
			return nil, a.Fail("PERMISSION_DENIED", "File attachments are not supported for webhook profiles", "Use an OAuth profile to send attachments")
		}
		return a.sendViaWebhook(o)
	}
	if o.spaceID != "" {
		id, err := a.resolveSpaceID(o.spaceID)
		if err != nil {
			return nil, err
		}
		o.spaceID = id
	}
	return a.sendViaOAuth(o)
}

// body is Bun `options.payload ?? { text: options.text }`.
func (o sendOptions) body() any {
	if o.payload != nil {
		return o.payload
	}
	if o.text == "" {
		return map[string]any{}
	}
	return map[string]any{"text": o.text}
}

func (a *api) sendViaWebhook(o sendOptions) (*sendResult, error) {
	webhookURL, _ := a.Credentials.Value("webhookUrl").(string)
	if jsvalue.Trim(webhookURL) == "" || !strings.HasPrefix(webhookURL, "https://") {
		return nil, a.Fail("INVALID_PARAMS", "Invalid webhook URL - must be HTTPS", "Check the webhook URL configuration")
	}
	resp, err := postJSON(a.Ctx, a.Fetch, webhookURL, o.body())
	if err != nil {
		return nil, a.Fail("NETWORK_ERROR", "Webhook request failed: "+err.Error(), "Verify the webhook URL is correct and accessible")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, a.Fail("NETWORK_ERROR", "Webhook request failed: "+err.Error(), "Verify the webhook URL is correct and accessible")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, a.Fail("API_ERROR", fmt.Sprintf("Failed to send message via webhook: %d %s", resp.StatusCode, raw),
			"Check that the webhook URL is valid and the bot has permission to post")
	}
	// The message was sent; an unreadable body only loses the id.
	var data struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(raw, &data)
	return &sendResult{MessageID: lastSegment(data.Name), Text: o.text, IsJSONPayload: jsvalue.Truthy(o.payload)}, nil
}

func (a *api) sendViaOAuth(o sendOptions) (*sendResult, error) {
	if o.spaceID == "" {
		return nil, a.Fail("INVALID_PARAMS", "spaceId is required for OAuth profiles", "Specify with --space or configure default in profile")
	}
	refs, err := a.uploadAttachments(o.spaceID, o.attachments)
	if err != nil {
		return nil, err
	}
	// Bun `options.payload ? { ...options.payload } : { text: options.text }`,
	// sent as it is: the API, not the client, judges the fields.
	body := jsvalue.NewObject()
	if jsvalue.Truthy(o.payload) {
		body = jsvalue.Spread(o.payload)
	} else if o.text != "" {
		body.Set("text", o.text)
	}
	if len(refs) > 0 {
		existing, _ := jsvalue.Member(body, "attachment").([]any)
		attachments := append([]any{}, existing...)
		for _, ref := range refs {
			item := jsvalue.NewObject()
			item.Set("attachmentDataRef", ref)
			attachments = append(attachments, item)
		}
		body.Set("attachment", attachments)
	}
	const suggestion = "Check that the space ID is valid and OAuth token is not expired"
	parent := strings.ReplaceAll(url.PathEscape("spaces/"+o.spaceID), "%2F", "/") // {+parent}
	// CallJSON, not the SDK: the payload goes as the user wrote it, and
	// chat.Message would drop fields it does not know and reorder the rest.
	created, err := google.CallJSON(a.Ctx, a.RunContext, google.Camel, http.MethodPost, a.chat.BasePath, "v1/"+parent+"/messages", jsvalue.Stringify(body))
	if err == nil && jsvalue.Nullish(created) {
		err = jsvalue.TypeError(created, createdName)
	}
	if err != nil {
		return nil, a.StatusError("Failed to send message: ", err, suggestion)
	}
	return &sendResult{MessageID: messageID(jsvalue.Member(created, "name")), SpaceID: o.spaceID, Text: o.text, IsJSONPayload: jsvalue.Truthy(o.payload)}, nil
}

// createdName and uploadedRef are the expressions JavaScriptCore reports for
// `response.data.name` in sendViaOAuth and `response.data.attachmentDataRef`
// in uploadAttachment: Bun's transpiler inlines the single-use response.
const (
	createdName = "(await chat.spaces.messages.create({\n" +
		"          parent: `spaces/${options.spaceId}`,\n" +
		"          requestBody\n" +
		"        })).data.name"
	uploadedRef = "(await chat.media.upload({\n" +
		"        parent: `spaces/${spaceId}`,\n" +
		"        requestBody: { filename },\n" +
		"        media: { mimeType, body: createReadStream(filePath) }\n" +
		"      })).data.attachmentDataRef"
)

// uploadAttachments is Bun's Promise.all over uploadAttachment: every upload
// runs at once, the refs keep the paths' order, and the first upload to fail
// is the error.
func (a *api) uploadAttachments(spaceID string, paths []string) ([]any, error) {
	refs := make([]any, len(paths))
	tasks := make([]func() error, len(paths))
	for i, path := range paths {
		tasks[i] = func() error {
			ref, err := a.uploadAttachment(spaceID, path)
			refs[i] = ref
			return err
		}
	}
	return refs, plugins.All(tasks...)
}

// uploadAttachment returns the answer's attachmentDataRef as it came.
func (a *api) uploadAttachment(spaceID, path string) (any, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, a.Fail("INVALID_PARAMS", "Failed to read attachment: "+path, "Check that the file exists and is readable")
	}
	filename := filepath.Base(path)
	mime, ok := attachmentMIME[strings.ToLower(nodefs.Extname(filename))]
	if !ok {
		mime = "application/octet-stream"
	}
	const suggestion = "Check that the space ID is valid, OAuth scope includes chat.messages.create, and the file is under 200MB"
	prefix := fmt.Sprintf("Failed to upload attachment \"%s\": ", filename)
	f, err := os.Open(path)
	if err != nil {
		return nil, a.Fail("API_ERROR", prefix+err.Error(), suggestion)
	}
	defer f.Close()
	_, data, err := google.Answer(a.Ctx, a.chat.Media.Upload("spaces/"+spaceID, &chat.UploadAttachmentRequest{Filename: filename}).
		Media(f, googleapi.ContentType(mime)))
	if err == nil && jsvalue.Nullish(data) {
		err = jsvalue.TypeError(data, uploadedRef)
	}
	if err != nil {
		return nil, a.StatusError(prefix, err, suggestion)
	}
	ref := jsvalue.Member(data, "attachmentDataRef")
	if !jsvalue.Truthy(ref) {
		return nil, a.Fail("API_ERROR", fmt.Sprintf("Upload of \"%s\" returned no attachmentDataRef", filename),
			"Retry, or check that the file size is under the Chat API limit (200MB)")
	}
	return ref, nil
}

type listOptions struct {
	spaceID                string
	limit                  float64
	threadID, since, until string
}

// list returns the newest messages first and whether --limit cut the range.
func (a *api) list(o listOptions) ([]any, bool, error) {
	if jsvalue.Trim(o.spaceID) == "" {
		return nil, false, a.Fail("INVALID_PARAMS", "spaceId is required for listing messages", "Specify with --space or configure default in profile")
	}
	if err := a.ensureOAuth("Listing messages"); err != nil {
		return nil, false, err
	}
	spaceID, err := a.resolveSpaceID(o.spaceID)
	if err != nil {
		return nil, false, err
	}
	const prefix, suggestion = "Failed to list messages: ", "Check that the space ID is valid and OAuth token is not expired"
	var filters []string
	if o.threadID != "" {
		filters = append(filters, fmt.Sprintf(`thread.name = "spaces/%s/threads/%s"`, spaceID, o.threadID))
	}
	for _, bound := range []struct{ value, op string }{{o.since, ">"}, {o.until, "<"}} {
		if bound.value == "" {
			continue
		}
		t, ok := jsvalue.ParseDate(bound.value)
		if !ok {
			// JavaScriptCore: new Date(...).toISOString() throws RangeError "Invalid Date".
			return nil, false, a.Fail("API_ERROR", prefix+"Invalid Date", suggestion)
		}
		filters = append(filters, fmt.Sprintf(`createTime %s "%s"`, bound.op, jsvalue.ISOString(t)))
	}
	limit := o.limit
	if math.IsNaN(limit) || limit == 0 { // options.limit || 10
		limit = 10
	}
	// The Chat API caps pageSize at 1000; page until the limit is reached.
	var raw []any
	var pageToken any = jsvalue.Undefined
	for {
		call := a.chat.Spaces.Messages.List("spaces/" + spaceID).
			PageSize(int64(min(limit-float64(len(raw)), 1000))).OrderBy("createTime desc")
		if len(filters) > 0 {
			call.Filter(strings.Join(filters, " AND "))
		}
		if jsvalue.Truthy(pageToken) {
			call.PageToken(jsvalue.String(pageToken))
		}
		messages, next, err := page(a.Ctx, call, "messages")
		if err != nil {
			return nil, false, a.StatusError(prefix, err, suggestion)
		}
		raw = append(raw, messages...)
		if pageToken = next; !jsvalue.Truthy(pageToken) || float64(len(raw)) >= limit {
			break
		}
	}
	truncated := jsvalue.Truthy(pageToken)
	if float64(len(raw)) > limit {
		if limit < 0 {
			// `messages.length = limit` throws on a negative length.
			return nil, false, a.Fail("API_ERROR", prefix+"Invalid array length", suggestion)
		}
		raw = raw[:int(limit)]
	}
	// Bun `[...new Set(messages.map(m => m.sender?.name).filter(Boolean))]`.
	var senders []any
	for _, m := range raw {
		if jsvalue.Nullish(m) {
			return nil, false, a.StatusError(prefix, jsvalue.TypeError(m, "m.sender"), suggestion)
		}
		if name := jsvalue.Optional(jsvalue.Member(m, "sender"), "name"); jsvalue.Truthy(name) && !slices.ContainsFunc(senders, func(s any) bool { return jsvalue.StrictEqual(s, name) }) {
			senders = append(senders, name)
		}
	}
	a.resolveUsers(senders)
	out := []any{}
	for _, m := range raw {
		out = append(out, a.messageOf(m))
	}
	return out, truncated, nil
}

// page is one page of a Chat list call: `response.data.<key> || []` and
// `response.data.nextPageToken || undefined`.
func page[C google.Call[C, T], T any](ctx context.Context, call C, key string) ([]any, any, error) {
	_, data, err := google.Answer(ctx, call)
	if err != nil {
		return nil, nil, err
	}
	v, err := jsvalue.Path(data, "response.data", key)
	if err != nil {
		return nil, nil, err
	}
	items, err := jsvalue.Items(jsvalue.Or(v, []any{}), "(response.data."+key+" || [])")
	if err != nil {
		return nil, nil, err
	}
	return items, jsvalue.Or(jsvalue.Member(data, "nextPageToken"), jsvalue.Undefined), nil
}

func (a *api) get(spaceID, messageID string) (*jsvalue.Object, error) {
	if jsvalue.Trim(spaceID) == "" || jsvalue.Trim(messageID) == "" {
		return nil, a.Fail("INVALID_PARAMS", "Both spaceId and messageId are required", "Specify with --space and message ID")
	}
	if err := a.ensureOAuth("Getting messages"); err != nil {
		return nil, err
	}
	spaceID, err := a.resolveSpaceID(spaceID)
	if err != nil {
		return nil, err
	}
	_, msg, err := google.Answer(a.Ctx, a.chat.Spaces.Messages.Get(fmt.Sprintf("spaces/%s/messages/%s", spaceID, messageID)))
	if err == nil && !jsvalue.Truthy(msg) {
		err = errors.New("Message not found")
	}
	if err != nil {
		return nil, a.StatusError("Failed to get message: ", err, "Check that the space ID and message ID are valid")
	}
	if name := jsvalue.Optional(jsvalue.Member(msg, "sender"), "name"); jsvalue.Truthy(name) {
		a.resolveUsers([]any{name})
	}
	return a.messageOf(msg), nil
}

// messageOf is the GChatMessage Bun's list and get build from msg.
func (a *api) messageOf(msg any) *jsvalue.Object {
	get := func(k string) any { return jsvalue.Member(msg, k) }
	out := jsvalue.ObjectOf(
		"name", jsvalue.Or(get("name"), ""),
		"createTime", jsvalue.Or(get("createTime"), jsvalue.ISOString(now())),
		"updateTime", jsvalue.Or(get("lastUpdateTime"), jsvalue.ISOString(now())),
	)
	if jsvalue.Truthy(get("text")) {
		out.Set("text", get("text"))
	}
	out.Set("sender", a.enrichSender(msg))
	if name := jsvalue.Optional(get("thread"), "name"); jsvalue.Truthy(name) {
		out.Set("thread", jsvalue.ObjectOf("name", name))
	}
	return out
}

// enrichSender is Bun enrichSender: the resolved name and email, else the
// message's own, else the id; undefined without a sender id.
func (a *api) enrichSender(msg any) any {
	s := jsvalue.Member(msg, "sender")
	name := jsvalue.Optional(s, "name")
	if !jsvalue.Truthy(name) {
		return jsvalue.Undefined
	}
	cached := resolvedUser{displayName: jsvalue.Undefined, email: jsvalue.Undefined}
	if id, ok := name.(string); ok {
		if c, ok := a.users[id]; ok {
			cached = c
		}
	}
	return jsvalue.ObjectOf(
		"name", name,
		"displayName", jsvalue.Or(jsvalue.Or(cached.displayName, jsvalue.Member(s, "displayName")), name),
		"email", cached.email,
	)
}

func (a *api) listSpaces() ([]any, error) {
	if err := a.ensureOAuth("Listing spaces"); err != nil {
		return nil, err
	}
	return a.listSpacesViaOAuth()
}

func (a *api) listSpacesViaOAuth() ([]any, error) {
	const prefix, suggestion = "Failed to list spaces: ", "Check that OAuth token is valid and has Chat scope"
	out := []any{}
	var pageToken any = jsvalue.Undefined
	for {
		call := a.chat.Spaces.List().PageSize(100)
		if jsvalue.Truthy(pageToken) {
			call.PageToken(jsvalue.String(pageToken))
		}
		spaces, next, err := page(a.Ctx, call, "spaces")
		if err != nil {
			return nil, a.StatusError(prefix, err, suggestion)
		}
		for _, s := range spaces {
			entry, err := spaceOf(s)
			if err != nil {
				return nil, a.StatusError(prefix, err, suggestion)
			}
			out = append(out, entry)
		}
		if pageToken = next; !jsvalue.Truthy(pageToken) {
			return out, nil
		}
	}
}

// spaceOf is the GChatSpace Bun's space list builds. It prefers spaceType
// (current API) over type (legacy): some DMs come back with type ROOM but
// spaceType DIRECT_MESSAGE.
func spaceOf(s any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(s) {
		return nil, jsvalue.TypeError(s, "space.spaceType")
	}
	get := func(k string) any { return jsvalue.Member(s, k) }
	kind := "ROOM"
	if st := get("spaceType"); jsvalue.StrictEqual(st, "DIRECT_MESSAGE") || jsvalue.StrictEqual(st, "GROUP_CHAT") || jsvalue.StrictEqual(get("type"), "DM") {
		kind = "DM"
	}
	return jsvalue.ObjectOf(
		"name", jsvalue.Or(get("name"), ""),
		"displayName", jsvalue.Or(get("displayName"), "Unnamed"),
		"type", kind,
		"description", jsvalue.Or(jsvalue.Optional(get("spaceDetails"), "description"), jsvalue.Undefined),
	), nil
}

// resolveSpaceID takes an id, or a display name looked up in the space list.
func (a *api) resolveSpaceID(idOrName string) (string, error) {
	if _, s, err := google.Answer(a.Ctx, a.chat.Spaces.Get("spaces/"+idOrName)); err == nil && !jsvalue.Nullish(s) && google.Truthy(s, "name") {
		return idOrName, nil
	}
	spaces, err := a.listSpacesViaOAuth()
	if err != nil {
		return "", err
	}
	for _, s := range spaces {
		if strings.EqualFold(google.Field(s, "displayName"), idOrName) {
			return strings.Replace(google.Field(s, "name"), "spaces/", "", 1), nil
		}
	}
	return "", a.Fail("NOT_FOUND", fmt.Sprintf("Space not found: \"%s\"", idOrName), `Use "agentio gchat spaces" to list available spaces`)
}

func (a *api) findDirectMessage(emailOrUserID string) (*jsvalue.Object, error) {
	if err := a.ensureOAuth("Finding direct message"); err != nil {
		return nil, err
	}
	// Warm the directory once so resolution and the display name agree.
	if d := a.directory(); d != nil {
		_ = d.ensureFresh(false)
	}
	resource, err := a.resolveUserResourceName(emailOrUserID)
	if err != nil {
		return nil, err
	}
	// Bun calls findDirectMessage with plain fetch: no retries, its own errors.
	token, err := google.AccessToken(a.Ctx, a.RunContext, google.Camel)
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, a.Fail("AUTH_FAILED", "Failed to obtain access token", "")
	}
	req, err := http.NewRequestWithContext(a.Ctx, http.MethodGet, a.chat.BasePath+"v1/spaces:findDirectMessage?name="+jsvalue.EncodeURIComponent(resource), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.Fetch(a.Ctx, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 404 {
		return nil, a.Fail("NOT_FOUND", "No direct message space exists with "+emailOrUserID, "Open the chat once in Google Chat to create the DM space")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, a.Fail(plugins.HTTPStatusToErrorCode(resp.StatusCode), fmt.Sprintf("findDirectMessage failed: %d %s", resp.StatusCode, raw),
			"Check that the OAuth scope includes chat.spaces.readonly")
	}
	data, err := plugins.ResponseJSON(resp.StatusCode, raw)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return nil, jsvalue.TypeError(nil, "data.displayName")
	}
	name, _ := jsvalue.Member(data, "displayName").(string)
	if name == "" {
		if d := a.directory(); d != nil {
			if entry := d.lookup(resource); entry != nil {
				name = entry.DisplayName
			}
		}
	}
	if name == "" {
		name = "Unnamed"
	}
	spaceName, _ := jsvalue.Member(data, "name").(string)
	return jsvalue.ObjectOf("name", spaceName, "displayName", name, "type", "DM", "description", jsvalue.Undefined), nil
}

var digits = regexp.MustCompile(`^[0-9]+$`)

func (a *api) resolveUserResourceName(input string) (string, error) {
	if strings.HasPrefix(input, "users/") {
		return input, nil
	}
	if digits.MatchString(input) {
		return "users/" + input, nil
	}
	if !strings.Contains(input, "@") {
		return "", a.Fail("INVALID_PARAMS", fmt.Sprintf("Cannot resolve \"%s\" to a user", input),
			"Provide an email address, numeric user ID, or users/<id> resource name")
	}
	d := a.directory()
	if d == nil {
		return "", a.Fail("CONFIG_ERROR", "Directory cache requires an OAuth profile with an email", "")
	}
	if err := d.ensureFresh(false); err != nil {
		return "", a.Fail("API_ERROR", "Failed to refresh workspace directory: "+err.Error(), "Check OAuth scope and network connectivity")
	}
	userID, _ := d.lookupByEmail(input)
	if userID == "" {
		return "", a.Fail("NOT_FOUND", "Email not found in workspace directory: "+input,
			`Run "agentio gchat directory refresh" if the user was added recently`)
	}
	return userID, nil
}

func (a *api) listMembers(spaceIDOrName string) ([]any, error) {
	if err := a.ensureOAuth("Listing members"); err != nil {
		return nil, err
	}
	spaceID, err := a.resolveSpaceID(spaceIDOrName)
	if err != nil {
		return nil, err
	}
	const prefix, suggestion = "Failed to list members: ", "Check that the space ID is valid and OAuth token is not expired"
	var all []any
	var pageToken any = jsvalue.Undefined
	for {
		call := a.chat.Spaces.Members.List("spaces/" + spaceID).PageSize(100)
		if jsvalue.Truthy(pageToken) {
			call.PageToken(jsvalue.String(pageToken))
		}
		members, next, err := page(a.Ctx, call, "memberships")
		if err != nil {
			return nil, a.StatusError(prefix, err, suggestion)
		}
		all = append(all, members...)
		if pageToken = next; !jsvalue.Truthy(pageToken) {
			break
		}
	}
	var names []string
	for _, m := range all {
		if jsvalue.Nullish(m) {
			return nil, a.StatusError(prefix, jsvalue.TypeError(m, "m.member"), suggestion)
		}
		if name, ok := jsvalue.Optional(jsvalue.Member(m, "member"), "name").(string); ok && strings.HasPrefix(name, "users/") {
			names = append(names, name)
		}
	}
	byName := map[string]*jsvalue.Object{}
	for _, u := range a.fetchPersons(names) {
		if u != nil {
			byName[google.Field(u, "name")] = u
		}
	}
	out := []any{}
	for _, m := range all {
		get := func(k string) any { return jsvalue.Member(m, k) }
		inner := get("member")
		userName := jsvalue.Optional(inner, "name")
		var u any = jsvalue.Undefined
		if jsvalue.Truthy(userName) {
			if id, ok := userName.(string); ok && byName[id] != nil {
				u = byName[id]
			} else {
				u = jsvalue.ObjectOf("name", userName, "displayName", jsvalue.Or(jsvalue.Optional(inner, "displayName"), jsvalue.Undefined))
			}
		}
		out = append(out, jsvalue.ObjectOf(
			"name", jsvalue.Or(get("name"), ""),
			"role", jsvalue.Or(get("role"), "ROLE_UNSPECIFIED"),
			"state", jsvalue.Or(get("state"), "MEMBERSHIP_STATE_UNSPECIFIED"),
			"memberType", jsvalue.Or(jsvalue.Optional(inner, "type"), "HUMAN"),
			"user", u,
		))
	}
	return out, nil
}

func (a *api) getUser(userID string) (*jsvalue.Object, error) {
	if err := a.ensureOAuth("Getting user info"); err != nil {
		return nil, err
	}
	resource := userID
	if !strings.HasPrefix(resource, "users/") {
		resource = "users/" + resource
	}
	u := a.fetchPersons([]string{resource})[0]
	if u == nil {
		return nil, a.Fail("NOT_FOUND", fmt.Sprintf("User not found: \"%s\"", userID), "Check the user ID is valid")
	}
	return u, nil
}

const (
	fullPersonFields = "names,emailAddresses,phoneNumbers,organizations,photos,locations"
	namePersonFields = "names,emailAddresses"
)

// personReply is one People API answer: data is `await res.json()`.
type personReply struct {
	data any
	err  error
}

// getPeople fetches people/<id> for each users/<id>, all at once (Bun
// Promise.all), each with plain fetch as Bun does: no retries. A status that
// is not ok is a *googleapi.Error; a body that is not JSON is an error.
func (a *api) getPeople(names []string, fields string) map[string]personReply {
	out := make(map[string]personReply, len(names))
	if len(names) == 0 {
		return out
	}
	token, err := google.AccessToken(a.Ctx, a.RunContext, google.Camel)
	if err == nil && token == "" {
		err = errors.New("no access token")
	}
	var unique []string
	for _, name := range names {
		if _, dup := out[name]; !dup {
			out[name] = personReply{err: err}
			unique = append(unique, name)
		}
	}
	if err != nil {
		return out
	}
	replies := make([]personReply, len(unique))
	var wg sync.WaitGroup
	for i, name := range unique {
		wg.Add(1)
		go func() {
			defer wg.Done()
			data, err := a.fetchPerson(token, strings.Replace(name, "users/", "", 1), fields)
			replies[i] = personReply{data: data, err: err}
		}()
	}
	wg.Wait()
	for i, name := range unique {
		out[name] = replies[i]
	}
	return out
}

// fetchPerson is Bun's `fetch(people/<id>?personFields=…)`, then res.json().
func (a *api) fetchPerson(token, id, fields string) (any, error) {
	req, err := http.NewRequestWithContext(a.Ctx, http.MethodGet, a.people.BasePath+"v1/people/"+id+"?personFields="+fields, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := a.Fetch(a.Ctx, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &googleapi.Error{Code: resp.StatusCode, Body: string(raw)}
	}
	return plugins.ResponseJSON(resp.StatusCode, raw)
}

// fetchPersons is Bun fetchPerson for each name, the People API calls in
// parallel: the full profile, or the workspace directory when the API has
// nothing. A name that cannot be resolved is nil.
func (a *api) fetchPersons(names []string) []*jsvalue.Object {
	var missing []string
	for _, name := range names {
		if a.fullUsers[name] == nil {
			missing = append(missing, name)
		}
	}
	replies := a.getPeople(missing, fullPersonFields)
	out := make([]*jsvalue.Object, len(names))
	for i, name := range names {
		if cached := a.fullUsers[name]; cached != nil {
			out[i] = cached
			continue
		}
		out[i] = a.personToUser(name, replies[name])
	}
	return out
}

// first is Bun `data.<key>?.[0]?.<field>`.
func first(data any, key, field string) any {
	return jsvalue.Optional(jsvalue.Optional(jsvalue.Member(data, key), "0"), field)
}

// mapped is Bun `data.<key>?.map(f)`: undefined when the list is nullish; a
// null item or a list that is not an array throws (Bun's catch then drops
// the person).
func mapped(data any, key string, f func(any) any) (any, error) {
	v := jsvalue.Member(data, key)
	if jsvalue.Nullish(v) {
		return jsvalue.Undefined, nil
	}
	items, err := jsvalue.Items(v, "data."+key+"?")
	if err != nil {
		return nil, err
	}
	out := []any{}
	for _, item := range items {
		if jsvalue.Nullish(item) {
			return nil, jsvalue.TypeError(item, "item")
		}
		out = append(out, f(item))
	}
	return out, nil
}

// values is Bun `data.<key>?.map(x => x.value).filter(v => !!v)`.
func values(data any, key string) (any, error) {
	all, err := mapped(data, key, func(x any) any { return jsvalue.Member(x, "value") })
	list, ok := all.([]any)
	if err != nil || !ok {
		return all, err
	}
	kept := []any{}
	for _, v := range list {
		if jsvalue.Truthy(v) {
			kept = append(kept, v)
		}
	}
	return kept, nil
}

// nonEmpty is Bun `list?.length ? list : undefined`.
func nonEmpty(list any) any {
	if l, ok := list.([]any); ok && len(l) > 0 {
		return l
	}
	return jsvalue.Undefined
}

// personToUser is the rest of Bun fetchPerson: a failed status falls back to
// the directory; any other failure, or an answer it cannot read, is nil.
func (a *api) personToUser(name string, reply personReply) *jsvalue.Object {
	if reply.err != nil {
		var ge *googleapi.Error
		if errors.As(reply.err, &ge) {
			return a.fallbackToDirectory(name)
		}
		return nil
	}
	data := reply.data
	if jsvalue.Nullish(data) {
		return nil // data.names: TypeError, caught
	}
	displayName, email := first(data, "names", "displayName"), first(data, "emailAddresses", "value")
	phones, err := values(data, "phoneNumbers")
	if err != nil {
		return nil
	}
	orgs, err := mapped(data, "organizations", func(o any) any {
		get := func(k string) any { return jsvalue.Member(o, k) }
		return jsvalue.ObjectOf("name", get("name"), "title", get("title"), "department", get("department"))
	})
	if err != nil {
		return nil
	}
	photo := first(data, "photos", "url")
	locations, err := values(data, "locations")
	if err != nil {
		return nil
	}
	// Workspace coworkers come back 200 with empty fields; use the directory.
	if !jsvalue.Truthy(displayName) && !jsvalue.Truthy(email) {
		if fallback := a.fallbackToDirectory(name); fallback != nil {
			return fallback
		}
	}
	u := jsvalue.ObjectOf(
		"name", name,
		"displayName", displayName,
		"email", email,
		"phoneNumbers", nonEmpty(phones),
		"organizations", nonEmpty(orgs),
		"photoUrl", photo,
		"locations", nonEmpty(locations),
	)
	a.fullUsers[name] = u
	if jsvalue.Truthy(displayName) {
		a.users[name] = resolvedUser{displayName: displayName, email: email}
	}
	return u
}

// entryEmail is a directory entry's email: undefined when it has none.
func entryEmail(e *directoryEntry) any {
	if e.Email == "" {
		return jsvalue.Undefined
	}
	return e.Email
}

func (a *api) fallbackToDirectory(name string) *jsvalue.Object {
	d := a.directory()
	if d == nil || d.ensureFresh(false) != nil {
		return nil
	}
	entry := d.lookup(name)
	if entry == nil {
		return nil
	}
	u := jsvalue.ObjectOf("name", name, "displayName", entry.DisplayName, "email", entryEmail(entry))
	a.fullUsers[name] = u
	a.users[name] = resolvedUser{displayName: entry.DisplayName, email: entryEmail(entry)}
	return u
}

// resolveUsers names message senders: the workspace directory first, then
// the People API for anyone it does not know (self, personal contacts). An
// id that is not a string resolves to nothing (Bun's userId.replace throws
// and is skipped), but still costs the directory refresh.
func (a *api) resolveUsers(ids []any) {
	var unknown []any
	for _, id := range ids {
		if s, ok := id.(string); !ok || !a.known(s) {
			unknown = append(unknown, id)
		}
	}
	if len(unknown) == 0 {
		return
	}
	if d := a.directory(); d != nil {
		_ = d.ensureFresh(false)
		for _, id := range unknown {
			if s, ok := id.(string); ok {
				if entry := d.lookup(s); entry != nil {
					a.users[s] = resolvedUser{displayName: entry.DisplayName, email: entryEmail(entry)}
				}
			}
		}
	}
	var still []string
	for _, id := range unknown {
		if s, ok := id.(string); ok && !a.known(s) {
			still = append(still, s)
		}
	}
	for id, reply := range a.getPeople(still, namePersonFields) {
		if reply.err != nil || jsvalue.Nullish(reply.data) {
			continue
		}
		if name := first(reply.data, "names", "displayName"); jsvalue.Truthy(name) {
			a.users[id] = resolvedUser{displayName: name, email: first(reply.data, "emailAddresses", "value")}
		}
	}
}

func (a *api) known(id string) bool {
	_, ok := a.users[id]
	return ok
}

// directory is the workspace directory of an OAuth profile with an email.
func (a *api) directory() *directory {
	if a.Credentials.Value("type") != "oauth" {
		return nil
	}
	if a.dir == nil {
		email, _ := a.Credentials.Value("email").(string)
		if email == "" {
			return nil
		}
		a.dir = newDirectory(a.Ctx, a.people, email)
	}
	return a.dir
}

func (a *api) refreshDirectory() (*directoryRefresh, error) {
	if err := a.ensureOAuth("Refreshing directory"); err != nil {
		return nil, err
	}
	d := a.directory()
	if d == nil {
		return nil, a.Fail("CONFIG_ERROR", "Directory cache requires an OAuth profile with an email", "")
	}
	if err := d.ensureFresh(true); err != nil {
		return nil, err
	}
	path, err := d.filePath()
	if err != nil {
		return nil, err
	}
	fetchedAt := d.fetchedAt()
	if fetchedAt == "" {
		fetchedAt = jsvalue.ISOString(now())
	}
	return &directoryRefresh{Size: d.size(), Path: path, FetchedAt: fetchedAt}, nil
}

// messageID is Bun `response.data.name?.split('/').pop() || 'unknown'`.
func messageID(name any) string {
	if jsvalue.Nullish(name) {
		return "unknown"
	}
	return lastSegment(jsvalue.String(name))
}

// lastSegment is Bun `name.split('/').pop() || 'unknown'`.
func lastSegment(name string) string {
	if s := name[strings.LastIndex(name, "/")+1:]; s != "" {
		return s
	}
	return "unknown"
}
