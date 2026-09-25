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

type sender struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email,omitempty"`
}

type thread struct {
	Name string `json:"name"`
}

// message is GChatMessage, in Bun's key order.
type message struct {
	Name       string  `json:"name"`
	CreateTime string  `json:"createTime"`
	UpdateTime string  `json:"updateTime"`
	Text       string  `json:"text,omitempty"`
	Sender     *sender `json:"sender,omitempty"`
	Thread     *thread `json:"thread,omitempty"`
}

type space struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

type organization struct {
	Name       string `json:"name,omitempty"`
	Title      string `json:"title,omitempty"`
	Department string `json:"department,omitempty"`
}

// user is GChatUser.
type user struct {
	Name          string         `json:"name"`
	DisplayName   string         `json:"displayName,omitempty"`
	Email         string         `json:"email,omitempty"`
	PhoneNumbers  []string       `json:"phoneNumbers,omitempty"`
	Organizations []organization `json:"organizations,omitempty"`
	PhotoURL      string         `json:"photoUrl,omitempty"`
	Locations     []string       `json:"locations,omitempty"`
}

type member struct {
	Name       string `json:"name"`
	Role       string `json:"role"`
	State      string `json:"state"`
	MemberType string `json:"memberType"`
	User       *user  `json:"user,omitempty"`
}

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

type resolvedUser struct {
	displayName string
	email       string
}

type api struct {
	google.API
	chat      *chat.Service
	people    *people.Service
	users     map[string]resolvedUser
	fullUsers map[string]*user
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
		chat: chatSvc, people: peopleSvc, users: map[string]resolvedUser{}, fullUsers: map[string]*user{},
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
	created, err := google.CallJSON(a.Ctx, a.RunContext, google.Camel, http.MethodPost, a.chat.BasePath, "v1/"+parent+"/messages", jsvalue.Stringify(body))
	if err != nil {
		return nil, a.StatusError("Failed to send message: ", err, suggestion)
	}
	name, _ := jsvalue.Member(created, "name").(string)
	return &sendResult{MessageID: lastSegment(name), SpaceID: o.spaceID, Text: o.text, IsJSONPayload: jsvalue.Truthy(o.payload)}, nil
}

// uploadAttachments is Bun's Promise.all over uploadAttachment: every upload
// runs at once, the refs keep the paths' order, and the first upload to fail
// is the error.
func (a *api) uploadAttachments(spaceID string, paths []string) ([]any, error) {
	refs := make([]any, len(paths))
	tasks := make([]func() error, len(paths))
	for i, path := range paths {
		tasks[i] = func() error {
			ref, err := a.uploadAttachment(spaceID, path)
			if err == nil {
				refs[i], _ = jsvalue.Parse(jsvalue.Stringify(ref))
			}
			return err
		}
	}
	return refs, plugins.All(tasks...)
}

func (a *api) uploadAttachment(spaceID, path string) (*chat.AttachmentDataRef, error) {
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
	resp, err := a.chat.Media.Upload("spaces/"+spaceID, &chat.UploadAttachmentRequest{Filename: filename}).
		Media(f, googleapi.ContentType(mime)).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.StatusError(prefix, err, suggestion)
	}
	if resp.AttachmentDataRef == nil {
		return nil, a.Fail("API_ERROR", fmt.Sprintf("Upload of \"%s\" returned no attachmentDataRef", filename),
			"Retry, or check that the file size is under the Chat API limit (200MB)")
	}
	return resp.AttachmentDataRef, nil
}

type listOptions struct {
	spaceID                string
	limit                  float64
	threadID, since, until string
}

// list returns the newest messages first and whether --limit cut the range.
func (a *api) list(o listOptions) ([]message, bool, error) {
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
	var raw []*chat.Message
	pageToken := ""
	for {
		call := a.chat.Spaces.Messages.List("spaces/" + spaceID).
			PageSize(int64(min(limit-float64(len(raw)), 1000))).OrderBy("createTime desc").Context(a.Ctx)
		if len(filters) > 0 {
			call.Filter(strings.Join(filters, " AND "))
		}
		if pageToken != "" {
			call.PageToken(pageToken)
		}
		resp, err := call.Do()
		if err != nil {
			return nil, false, a.StatusError(prefix, err, suggestion)
		}
		raw = append(raw, resp.Messages...)
		pageToken = resp.NextPageToken
		if pageToken == "" || float64(len(raw)) >= limit {
			break
		}
	}
	truncated := pageToken != ""
	if float64(len(raw)) > limit {
		if limit < 0 {
			// `messages.length = limit` throws on a negative length.
			return nil, false, a.Fail("API_ERROR", prefix+"Invalid array length", suggestion)
		}
		raw = raw[:int(limit)]
	}
	var senders []string
	seen := map[string]bool{}
	for _, m := range raw {
		if m.Sender != nil && m.Sender.Name != "" && !seen[m.Sender.Name] {
			seen[m.Sender.Name] = true
			senders = append(senders, m.Sender.Name)
		}
	}
	a.resolveUsers(senders)
	out := []message{}
	for _, m := range raw {
		out = append(out, a.toMessage(m))
	}
	return out, truncated, nil
}

func (a *api) get(spaceID, messageID string) (*message, error) {
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
	m, err := a.chat.Spaces.Messages.Get(fmt.Sprintf("spaces/%s/messages/%s", spaceID, messageID)).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.StatusError("Failed to get message: ", err, "Check that the space ID and message ID are valid")
	}
	if m.Sender != nil && m.Sender.Name != "" {
		a.resolveUsers([]string{m.Sender.Name})
	}
	out := a.toMessage(m)
	return &out, nil
}

func (a *api) toMessage(m *chat.Message) message {
	out := message{Name: m.Name, CreateTime: m.CreateTime, UpdateTime: m.LastUpdateTime, Text: m.Text, Sender: a.enrichSender(m)}
	if out.CreateTime == "" {
		out.CreateTime = jsvalue.ISOString(now())
	}
	if out.UpdateTime == "" {
		out.UpdateTime = jsvalue.ISOString(now())
	}
	if m.Thread != nil && m.Thread.Name != "" {
		out.Thread = &thread{Name: m.Thread.Name}
	}
	return out
}

func (a *api) enrichSender(m *chat.Message) *sender {
	if m.Sender == nil || m.Sender.Name == "" {
		return nil
	}
	cached := a.users[m.Sender.Name]
	name := cached.displayName
	if name == "" {
		name = m.Sender.DisplayName
	}
	if name == "" {
		name = m.Sender.Name
	}
	return &sender{Name: m.Sender.Name, DisplayName: name, Email: cached.email}
}

func (a *api) listSpaces() ([]space, error) {
	if err := a.ensureOAuth("Listing spaces"); err != nil {
		return nil, err
	}
	return a.listSpacesViaOAuth()
}

func (a *api) listSpacesViaOAuth() ([]space, error) {
	out := []space{}
	pageToken := ""
	for {
		call := a.chat.Spaces.List().PageSize(100).Context(a.Ctx)
		if pageToken != "" {
			call.PageToken(pageToken)
		}
		resp, err := call.Do()
		if err != nil {
			return nil, a.StatusError("Failed to list spaces: ", err, "Check that OAuth token is valid and has Chat scope")
		}
		for _, s := range resp.Spaces {
			// Prefer spaceType (current API) over type (legacy): some DMs come
			// back with type ROOM but spaceType DIRECT_MESSAGE.
			kind := "ROOM"
			if s.SpaceType == "DIRECT_MESSAGE" || s.SpaceType == "GROUP_CHAT" || s.Type == "DM" {
				kind = "DM"
			}
			entry := space{Name: s.Name, DisplayName: s.DisplayName, Type: kind}
			if entry.DisplayName == "" {
				entry.DisplayName = "Unnamed"
			}
			if s.SpaceDetails != nil {
				entry.Description = s.SpaceDetails.Description
			}
			out = append(out, entry)
		}
		pageToken = resp.NextPageToken
		if pageToken == "" {
			return out, nil
		}
	}
}

// resolveSpaceID takes an id, or a display name looked up in the space list.
func (a *api) resolveSpaceID(idOrName string) (string, error) {
	if s, err := a.chat.Spaces.Get("spaces/" + idOrName).Context(a.Ctx).Do(); err == nil && s.Name != "" {
		return idOrName, nil
	}
	spaces, err := a.listSpacesViaOAuth()
	if err != nil {
		return "", err
	}
	for _, s := range spaces {
		if strings.EqualFold(s.DisplayName, idOrName) {
			return strings.Replace(s.Name, "spaces/", "", 1), nil
		}
	}
	return "", a.Fail("NOT_FOUND", fmt.Sprintf("Space not found: \"%s\"", idOrName), `Use "agentio gchat spaces" to list available spaces`)
}

func (a *api) findDirectMessage(emailOrUserID string) (*space, error) {
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
	return &space{Name: spaceName, DisplayName: name, Type: "DM"}, nil
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

func (a *api) listMembers(spaceIDOrName string) ([]member, error) {
	if err := a.ensureOAuth("Listing members"); err != nil {
		return nil, err
	}
	spaceID, err := a.resolveSpaceID(spaceIDOrName)
	if err != nil {
		return nil, err
	}
	var all []*chat.Membership
	pageToken := ""
	for {
		call := a.chat.Spaces.Members.List("spaces/" + spaceID).PageSize(100).Context(a.Ctx)
		if pageToken != "" {
			call.PageToken(pageToken)
		}
		resp, err := call.Do()
		if err != nil {
			return nil, a.StatusError("Failed to list members: ", err, "Check that the space ID is valid and OAuth token is not expired")
		}
		all = append(all, resp.Memberships...)
		if pageToken = resp.NextPageToken; pageToken == "" {
			break
		}
	}
	var names []string
	for _, m := range all {
		if m.Member != nil && strings.HasPrefix(m.Member.Name, "users/") {
			names = append(names, m.Member.Name)
		}
	}
	byName := map[string]*user{}
	for _, u := range a.fetchPersons(names) {
		if u != nil {
			byName[u.Name] = u
		}
	}
	out := []member{}
	for _, m := range all {
		entry := member{Name: m.Name, Role: m.Role, State: m.State, MemberType: "HUMAN"}
		if entry.Role == "" {
			entry.Role = "ROLE_UNSPECIFIED"
		}
		if entry.State == "" {
			entry.State = "MEMBERSHIP_STATE_UNSPECIFIED"
		}
		if m.Member != nil {
			if m.Member.Type != "" {
				entry.MemberType = m.Member.Type
			}
			if u := byName[m.Member.Name]; u != nil {
				entry.User = u
			} else if m.Member.Name != "" {
				entry.User = &user{Name: m.Member.Name, DisplayName: m.Member.DisplayName}
			}
		}
		out = append(out, entry)
	}
	return out, nil
}

func (a *api) getUser(userID string) (*user, error) {
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

type personReply struct {
	person *people.Person
	err    error
}

// getPeople fetches people/<id> for each users/<id>, all at once (Bun
// Promise.all), each with plain fetch as Bun does: no retries. A status that
// is not ok is a *googleapi.Error; a body that is not a person is an error.
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
			p, err := a.fetchPerson(token, strings.Replace(name, "users/", "", 1), fields)
			replies[i] = personReply{person: p, err: err}
		}()
	}
	wg.Wait()
	for i, name := range unique {
		out[name] = replies[i]
	}
	return out
}

// fetchPerson is Bun's `fetch(people/<id>?personFields=…)`, then res.json().
func (a *api) fetchPerson(token, id, fields string) (*people.Person, error) {
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
	var p people.Person
	if null, err := plugins.DecodeJSON(resp.StatusCode, raw, &p); err != nil || null {
		return nil, errors.New("not a person")
	}
	return &p, nil
}

// fetchPersons is fetchPerson for each name, the People API calls in
// parallel: the full profile, or the workspace directory when the API has
// nothing. A name that cannot be resolved is nil.
func (a *api) fetchPersons(names []string) []*user {
	var missing []string
	for _, name := range names {
		if a.fullUsers[name] == nil {
			missing = append(missing, name)
		}
	}
	replies := a.getPeople(missing, fullPersonFields)
	out := make([]*user, len(names))
	for i, name := range names {
		if cached := a.fullUsers[name]; cached != nil {
			out[i] = cached
			continue
		}
		out[i] = a.personToUser(name, replies[name])
	}
	return out
}

func (a *api) personToUser(name string, reply personReply) *user {
	if reply.err != nil {
		var ge *googleapi.Error
		if errors.As(reply.err, &ge) {
			return a.fallbackToDirectory(name)
		}
		return nil
	}
	p := reply.person
	u := &user{Name: name, DisplayName: personName(p), Email: personEmail(p)}
	for _, n := range p.PhoneNumbers {
		if n != nil && n.Value != "" {
			u.PhoneNumbers = append(u.PhoneNumbers, n.Value)
		}
	}
	for _, o := range p.Organizations {
		if o != nil {
			u.Organizations = append(u.Organizations, organization{Name: o.Name, Title: o.Title, Department: o.Department})
		}
	}
	if len(p.Photos) > 0 && p.Photos[0] != nil {
		u.PhotoURL = p.Photos[0].Url
	}
	for _, l := range p.Locations {
		if l != nil && l.Value != "" {
			u.Locations = append(u.Locations, l.Value)
		}
	}
	// Workspace coworkers come back 200 with empty fields; use the directory.
	if u.DisplayName == "" && u.Email == "" {
		if fallback := a.fallbackToDirectory(name); fallback != nil {
			return fallback
		}
	}
	a.fullUsers[name] = u
	if u.DisplayName != "" {
		a.users[name] = resolvedUser{displayName: u.DisplayName, email: u.Email}
	}
	return u
}

func personName(p *people.Person) string {
	if len(p.Names) > 0 && p.Names[0] != nil {
		return p.Names[0].DisplayName
	}
	return ""
}

func personEmail(p *people.Person) string {
	if len(p.EmailAddresses) > 0 && p.EmailAddresses[0] != nil {
		return p.EmailAddresses[0].Value
	}
	return ""
}

func (a *api) fallbackToDirectory(name string) *user {
	d := a.directory()
	if d == nil || d.ensureFresh(false) != nil {
		return nil
	}
	entry := d.lookup(name)
	if entry == nil {
		return nil
	}
	u := &user{Name: name, DisplayName: entry.DisplayName, Email: entry.Email}
	a.fullUsers[name] = u
	a.users[name] = resolvedUser{displayName: entry.DisplayName, email: entry.Email}
	return u
}

// resolveUsers names message senders: the workspace directory first, then
// the People API for anyone it does not know (self, personal contacts).
func (a *api) resolveUsers(ids []string) {
	var unknown []string
	for _, id := range ids {
		if _, ok := a.users[id]; !ok {
			unknown = append(unknown, id)
		}
	}
	if len(unknown) == 0 {
		return
	}
	if d := a.directory(); d != nil {
		_ = d.ensureFresh(false)
		for _, id := range unknown {
			if entry := d.lookup(id); entry != nil {
				a.users[id] = resolvedUser{displayName: entry.DisplayName, email: entry.Email}
			}
		}
	}
	var still []string
	for _, id := range unknown {
		if _, ok := a.users[id]; !ok {
			still = append(still, id)
		}
	}
	for id, reply := range a.getPeople(still, namePersonFields) {
		if reply.err != nil || reply.person == nil {
			continue
		}
		if name := personName(reply.person); name != "" {
			a.users[id] = resolvedUser{displayName: name, email: personEmail(reply.person)}
		}
	}
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

// lastSegment is Bun `name.split('/').pop() || 'unknown'`.
func lastSegment(name string) string {
	if s := name[strings.LastIndex(name, "/")+1:]; s != "" {
		return s
	}
	return "unknown"
}
