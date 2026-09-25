package gmail

import (
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	"github.com/plosson/agentio/go/internal/retry"
	gmail "google.golang.org/api/gmail/v1"
)

const base36 = "0123456789abcdefghijklmnopqrstuvwxyz"

// listHardCap is Bun GMAIL_LIST_HARD_CAP.
const listHardCap = 10_000

// Clocks and randomness behind the MIME boundaries, the batch durations and
// the retry waits; tests replace them.
var (
	now        = time.Now
	randomBase = func() string {
		b := make([]byte, 11)
		for i := range b {
			b[i] = base36[rand.Intn(36)]
		}
		return string(b)
	}
	retrySleep = time.Sleep
)

// The models are the Bun client's objects (GmailMessage, GmailAttachmentInfo,
// GmailLabel, GmailFilter and the send and draft results), built from the
// answer as JavaScript reads it (google.Answer): a field the answer lacks is
// undefined, a null item fails with Bun's TypeError, and a value of another
// type is kept as it came.

// filterCriteria and filterAction are the filter create request, built from
// the options as Bun's parseFilterCriteriaFromOptions builds it.
type filterCriteria struct {
	From           string `json:"from,omitempty"`
	To             string `json:"to,omitempty"`
	Subject        string `json:"subject,omitempty"`
	Query          string `json:"query,omitempty"`
	NegatedQuery   string `json:"negatedQuery,omitempty"`
	HasAttachment  bool   `json:"hasAttachment,omitempty"`
	ExcludeChats   bool   `json:"excludeChats,omitempty"`
	Size           *int64 `json:"size,omitempty"`
	SizeComparison string `json:"sizeComparison,omitempty"`
}

type filterAction struct {
	AddLabelIDs    []string `json:"addLabelIds,omitempty"`
	RemoveLabelIDs []string `json:"removeLabelIds,omitempty"`
	Forward        string   `json:"forward,omitempty"`
}

type failedChunk struct {
	IDs    []string `json:"ids"`
	Reason string   `json:"reason"`
}

// batchResult is BatchModifyResult.
type batchResult struct {
	action   string
	TotalIDs int           `json:"totalIds"`
	OK       int           `json:"ok"`
	Failed   []failedChunk `json:"failed"`
	Chunks   int           `json:"chunks"`
}

// api is GmailClient.
type api struct {
	google.API
	svc       *gmail.Service
	userEmail string
}

func service(ctx context.Context, run *plugins.RunContext) (*gmail.Service, error) {
	return google.NewService(ctx, run, google.Snake, gmail.NewService)
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	svc, err := service(ctx, run)
	if err != nil {
		return nil, err
	}
	return &api{API: google.API{Ctx: ctx, RunContext: run}, svc: svc}, nil
}

// thrown is an error Bun does not catch: handleError prints its message
// without a code.
func thrown(err error) error {
	return errors.New(google.Message(err))
}

// member is `v.key` on a value read from an answer.
func member(v any, key string) any { return jsvalue.Member(v, key) }

// items is `for (const x of v || [])` over an answer's array.
func items(v any) []any {
	list, _ := jsvalue.Or(v, []any{}).([]any)
	return list
}

// notAFunction is JavaScriptCore's TypeError for calling callee, a member
// that is not a function, in the call expression call.
func notAFunction(callee, call string) error {
	return fmt.Errorf("%s is not a function. (In '%s', '%s' is undefined)", callee, call, callee)
}

// getUserEmail is GmailClient.getUserEmail: the profile address, else "me".
func (a *api) getUserEmail() (string, error) {
	if a.userEmail != "" {
		return a.userEmail, nil
	}
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.GetProfile("me"))
	if err != nil {
		return "", err
	}
	email, err := jsvalue.Path(raw, "profile.data", "emailAddress")
	if err != nil {
		return "", err
	}
	a.userEmail = jsvalue.String(jsvalue.Or(email, "me"))
	return a.userEmail, nil
}

// parseHeaders is GmailClient.parseHeaders: header names lower-cased, a
// later header wins, one without a name or a value skipped.
func parseHeaders(headers any) (map[string]any, error) {
	out := map[string]any{}
	for _, h := range items(headers) {
		if jsvalue.Nullish(h) {
			return nil, jsvalue.TypeError(h, "header.name")
		}
		name, value := member(h, "name"), member(h, "value")
		if !jsvalue.Truthy(name) || !jsvalue.Truthy(value) {
			continue
		}
		s, ok := name.(string)
		if !ok {
			return nil, notAFunction("header.name.toLowerCase", "header.name.toLowerCase()")
		}
		out[strings.ToLower(s)] = value
	}
	return out, nil
}

// header is `headers[name]`.
func header(headers map[string]any, name string) any {
	if v, ok := headers[name]; ok {
		return v
	}
	return jsvalue.Undefined
}

// addresses is parseMessage's parseAddresses.
func addresses(value any) ([]any, error) {
	if !jsvalue.Truthy(value) {
		return []any{}, nil
	}
	s, ok := value.(string)
	if !ok {
		return nil, notAFunction("value.split", `value.split(",")`)
	}
	out := []any{}
	for _, p := range strings.Split(s, ",") {
		out = append(out, jsvalue.Trim(p))
	}
	return out, nil
}

// extractAttachments is GmailClient.extractAttachments: every part with a
// file name and an attachment id, depth first.
func extractAttachments(payload any) ([]any, error) {
	out := []any{}
	var walk func(part any) error
	walk = func(part any) error {
		if jsvalue.Nullish(part) {
			return jsvalue.TypeError(part, "part.filename")
		}
		filename, body := member(part, "filename"), member(part, "body")
		if n, _ := member(filename, "length").(float64); jsvalue.Truthy(filename) && n > 0 && jsvalue.Truthy(jsvalue.Optional(body, "attachmentId")) {
			out = append(out, jsvalue.ObjectOf(
				"id", member(body, "attachmentId"),
				"filename", filename,
				"mimeType", jsvalue.Or(member(part, "mimeType"), "application/octet-stream"),
				"size", jsvalue.Or(member(body, "size"), 0),
			))
		}
		for _, child := range items(member(part, "parts")) {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if jsvalue.Truthy(payload) {
		if err := walk(payload); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// parseMessage is GmailClient.parseMessage.
func parseMessage(m any, withAttachments bool) (*jsvalue.Object, error) {
	if jsvalue.Nullish(m) {
		return nil, jsvalue.TypeError(m, "message.payload")
	}
	payload := member(m, "payload")
	headers, err := parseHeaders(jsvalue.Optional(payload, "headers"))
	if err != nil {
		return nil, err
	}
	to, err := addresses(header(headers, "to"))
	if err != nil {
		return nil, err
	}
	cc, err := addresses(header(headers, "cc"))
	if err != nil {
		return nil, err
	}
	out := jsvalue.ObjectOf(
		"id", member(m, "id"),
		"threadId", member(m, "threadId"),
		"subject", jsvalue.Or(header(headers, "subject"), "(no subject)"),
		"from", jsvalue.Or(header(headers, "from"), ""),
		"to", to,
		"cc", cc,
		"date", jsvalue.Or(header(headers, "date"), ""),
		"snippet", jsvalue.Or(member(m, "snippet"), ""),
		"labels", jsvalue.Or(member(m, "labelIds"), []any{}),
	)
	if withAttachments {
		atts, err := extractAttachments(payload)
		if err != nil {
			return nil, err
		}
		if len(atts) > 0 {
			out.Set("attachments", atts)
		}
	}
	return out, nil
}

// decodeBody is Buffer.from(data, 'base64').toString('utf-8').
func decodeBody(data any) string {
	return jsvalue.BufferString(jsvalue.DecodeBase64(jsvalue.String(data)))
}

// bodyOf is GmailClient.getBody: the first part of the preferred type, else
// of the other one. An empty decode counts as not found, as in Bun.
func bodyOf(payload any, preferHTML bool) (string, error) {
	if !jsvalue.Truthy(payload) {
		return "", nil
	}
	var find func(part any, mime string) (string, error)
	find = func(part any, mime string) (string, error) {
		if jsvalue.Nullish(part) {
			return "", jsvalue.TypeError(part, "part.mimeType")
		}
		if data := jsvalue.Optional(member(part, "body"), "data"); jsvalue.StrictEqual(member(part, "mimeType"), mime) && jsvalue.Truthy(data) {
			return decodeBody(data), nil
		}
		for _, child := range items(member(part, "parts")) {
			if r, err := find(child, mime); err != nil || r != "" {
				return r, err
			}
		}
		return "", nil
	}
	target, fallback := "text/plain", "text/html"
	if preferHTML {
		target, fallback = fallback, target
	}
	if r, err := find(payload, target); err != nil || r != "" {
		return r, err
	}
	return find(payload, fallback)
}

// messageList is list's { messages, total }.
type messageList struct{ *jsvalue.Object }

// list is GmailClient.list: ids page by page up to the capped limit, then
// metadata for each when the limit is 100 or less.
func (a *api) list(limit float64, query string, labels []string) (*messageList, error) {
	out, err := a.listMessages(limit, query, labels)
	if err != nil {
		return nil, a.APIError("Gmail API error", err)
	}
	return &messageList{out}, nil
}

func (a *api) listMessages(limit float64, query string, labels []string) (*jsvalue.Object, error) {
	capped := math.Min(math.Max(limit, 0), listHardCap)
	withMetadata := capped <= 100
	q := query
	if len(labels) > 0 {
		parts := make([]string, len(labels))
		for i, l := range labels {
			parts[i] = "label:" + l
		}
		q += " " + strings.Join(parts, " ")
	}
	q = jsvalue.Trim(q)

	type ref struct{ id, threadID any }
	var ids []ref
	var total any = 0
	pageToken := ""
	for float64(len(ids)) < capped {
		remaining := capped - float64(len(ids))
		call := a.svc.Users.Messages.List("me").MaxResults(int64(math.Min(remaining, 500)))
		if q != "" {
			call.Q(q)
		}
		if pageToken != "" {
			call.PageToken(pageToken)
		}
		_, raw, err := google.Answer(a.Ctx, call)
		if err != nil {
			return nil, err
		}
		if !jsvalue.Truthy(total) {
			estimate, err := jsvalue.Path(raw, "response.data", "resultSizeEstimate")
			if err != nil {
				return nil, err
			}
			total = jsvalue.Or(estimate, 0)
		}
		messages, err := jsvalue.Path(raw, "response.data", "messages")
		if err != nil {
			return nil, err
		}
		for _, m := range items(messages) {
			if jsvalue.Nullish(m) {
				return nil, jsvalue.TypeError(m, "m.id")
			}
			if id, threadID := member(m, "id"), member(m, "threadId"); jsvalue.Truthy(id) && jsvalue.Truthy(threadID) {
				ids = append(ids, ref{id, threadID})
				if float64(len(ids)) >= capped {
					break
				}
			}
		}
		next := member(raw, "nextPageToken")
		if !jsvalue.Truthy(next) {
			break
		}
		pageToken = jsvalue.String(next)
	}

	messages := []any{}
	for _, r := range ids {
		if !withMetadata {
			messages = append(messages, jsvalue.ObjectOf("id", r.id, "threadId", r.threadID, "subject", "", "from", "",
				"to", []any{}, "cc", []any{}, "date", "", "snippet", "", "labels", []any{}))
			continue
		}
		_, raw, err := google.Answer(a.Ctx, a.svc.Users.Messages.Get("me", jsvalue.String(r.id)).Format("metadata").
			MetadataHeaders("From", "To", "Cc", "Subject", "Date"))
		if err != nil {
			return nil, err
		}
		m, err := parseMessage(raw, false)
		if err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}
	return jsvalue.ObjectOf("messages", messages, "total", jsvalue.Or(total, float64(len(messages)))), nil
}

// message is get's `{ ...message, body }`.
type message struct{ *jsvalue.Object }

// get is GmailClient.get. format is Bun's text, html or raw; anything else
// reads like text.
func (a *api) get(id, format string) (*message, error) {
	apiFormat := "full"
	if format == "raw" {
		apiFormat = "raw"
	}
	out, err := a.readMessage(id, apiFormat, format)
	if err != nil {
		return nil, a.NotFoundOr("Message", id, "Gmail API error", err)
	}
	return &message{out}, nil
}

func (a *api) readMessage(id, apiFormat, format string) (*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Messages.Get("me", id).Format(apiFormat))
	if err != nil {
		return nil, err
	}
	m, err := parseMessage(raw, true)
	if err != nil {
		return nil, err
	}
	body := ""
	if format == "raw" {
		if data := member(raw, "raw"); jsvalue.Truthy(data) {
			body = decodeBody(data)
		}
	} else if body, err = bodyOf(member(raw, "payload"), format == "html"); err != nil {
		return nil, err
	}
	out := jsvalue.Spread(m)
	out.Set("body", body)
	return out, nil
}

type downloaded struct {
	data       []byte
	attachment *jsvalue.Object
}

// allAttachments is GmailClient.getAllAttachments.
func (a *api) allAttachments(id string) ([]downloaded, error) {
	out, err := a.readAttachments(id)
	if err != nil {
		return nil, a.NotFoundOr("Message", id, "Gmail API error", err)
	}
	return out, nil
}

func (a *api) readAttachments(id string) ([]downloaded, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Messages.Get("me", id).Format("full"))
	if err != nil {
		return nil, err
	}
	payload, err := jsvalue.Path(raw, "message.data", "payload")
	if err != nil {
		return nil, err
	}
	atts, err := extractAttachments(payload)
	if err != nil {
		return nil, err
	}
	out := []downloaded{}
	for _, att := range atts {
		_, body, err := google.Answer(a.Ctx, a.svc.Users.Messages.Attachments.Get("me", id, jsvalue.String(member(att, "id"))))
		if err != nil {
			return nil, err
		}
		data, err := jsvalue.Path(body, "response.data", "data")
		if err != nil {
			return nil, err
		}
		if jsvalue.Truthy(data) {
			out = append(out, downloaded{data: jsvalue.DecodeBase64(jsvalue.String(data)), attachment: att.(*jsvalue.Object)})
		}
	}
	return out, nil
}

// replyContext is GmailClient.resolveReplyContext: the last message of the
// thread gives the recipient, the subject and the threading headers.
func (a *api) replyContext(threadID string) (to []string, subject string, extra []string, err error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Threads.Get("me", threadID))
	if err != nil {
		return nil, "", nil, thrown(err)
	}
	// Bun's transpiler inlines the one-use thread in the expression it reports.
	messages, err := jsvalue.Path(raw, "(await this.gmail.users.threads.get({\n      userId: \"me\",\n      id: threadId\n    })).data", "messages")
	if err != nil {
		return nil, "", nil, err
	}
	list := items(messages)
	if len(list) == 0 {
		return nil, "", nil, a.Fail("NOT_FOUND", "Thread not found: "+threadID, "")
	}
	last := list[len(list)-1]
	if jsvalue.Nullish(last) {
		return nil, "", nil, jsvalue.TypeError(last, "lastMessage.payload")
	}
	headers, err := parseHeaders(jsvalue.Optional(member(last, "payload"), "headers"))
	if err != nil {
		return nil, "", nil, err
	}
	to = []string{jsvalue.String(jsvalue.Or(jsvalue.Or(header(headers, "reply-to"), header(headers, "from")), ""))}
	if s, ok := header(headers, "subject").(string); ok && strings.HasPrefix(s, "Re:") {
		subject = s
	} else {
		subject = "Re: " + jsvalue.String(jsvalue.Or(header(headers, "subject"), "(no subject)"))
	}
	if id := header(headers, "message-id"); jsvalue.Truthy(id) {
		extra = []string{"In-Reply-To: " + jsvalue.String(id), "References: " + jsvalue.String(id)}
	}
	return to, subject, extra, nil
}

var asciiOnly = regexp.MustCompile(`^[\x00-\x7F]*$`)

// encodeHeaderValue is Bun's RFC 2047 encoding of a non-ASCII header value.
func encodeHeaderValue(value string) string {
	if asciiOnly.MatchString(value) {
		return value
	}
	return "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(value)) + "?="
}

// mimeTypes is Bun MIME_TYPES.
var mimeTypes = map[string]string{
	".txt": "text/plain", ".html": "text/html", ".css": "text/css",
	".js": "application/javascript", ".json": "application/json", ".xml": "application/xml",
	".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
	".tar": "application/x-tar", ".png": "image/png", ".jpg": "image/jpeg",
	".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
	".webp": "image/webp", ".mp3": "audio/mpeg", ".mp4": "video/mp4",
	".wav": "audio/wav", ".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls":  "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt":  "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

var extension = regexp.MustCompile(`\.[^.]+$`)

func mimeTypeOf(filename string) string {
	if t, ok := mimeTypes[extension.FindString(strings.ToLower(filename))]; ok {
		return t
	}
	return "application/octet-stream"
}

type encodedAttachment struct {
	filename, mimeType, base64 string
}

// encodeAttachment is GmailClient.encodeAttachment: a missing file (or a
// directory, which Bun.file().exists() rejects) is NOT_FOUND.
func (a *api) encodeAttachment(att attachmentFile) (encodedAttachment, error) {
	info, err := os.Stat(att.path)
	if err != nil || info.IsDir() {
		return encodedAttachment{}, a.Fail("NOT_FOUND", "Attachment not found: "+att.path, "")
	}
	content, err := os.ReadFile(att.path)
	if err != nil {
		return encodedAttachment{}, a.Fail("API_ERROR", fmt.Sprintf("Failed to read attachment %s: %s", att.path, err.Error()), "")
	}
	filename := cmp.Or(att.filename, basename(att.path))
	return encodedAttachment{filename: filename, mimeType: mimeTypeOf(filename), base64: base64.StdEncoding.EncodeToString(content)}, nil
}

func contentType(isHTML bool) string {
	if isHTML {
		return "Content-Type: text/html; charset=utf-8"
	}
	return "Content-Type: text/plain; charset=utf-8"
}

// boundary is `----=_<kind>_${Date.now()}_${Math.random().toString(36).substring(2)}`.
func boundary(kind string) string {
	return fmt.Sprintf("----=_%s_%d_%s", kind, now().UnixMilli(), randomBase())
}

// buildEncodedMessage is GmailClient.buildEncodedMessage: the RFC 822 text,
// lines joined by CRLF, as unpadded base64url.
func (a *api) buildEncodedMessage(o *sendOptions) (string, error) {
	from, err := a.getUserEmail()
	if err != nil {
		return "", thrown(err)
	}
	to, subject := o.to, o.subject
	var extra []string
	if o.replyTo != "" {
		replyTo, replySubject, headers, err := a.replyContext(o.replyTo)
		if err != nil {
			return "", err
		}
		if len(to) == 0 {
			to = replyTo
		}
		if subject == "" {
			subject = replySubject
		}
		extra = headers
	}
	lines := []string{"From: " + from, "To: " + strings.Join(to, ", ")}
	if len(o.cc) > 0 {
		lines = append(lines, "Cc: "+strings.Join(o.cc, ", "))
	}
	if len(o.bcc) > 0 {
		lines = append(lines, "Bcc: "+strings.Join(o.bcc, ", "))
	}
	lines = append(lines, "Subject: "+encodeHeaderValue(subject))
	lines = append(lines, extra...)
	if len(o.attachments) == 0 {
		lines = append(lines, contentType(o.isHTML), "", o.body)
	} else {
		multipart, err := a.multipartLines(o)
		if err != nil {
			return "", err
		}
		lines = append(lines, multipart...)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strings.Join(lines, "\r\n"))), nil
}

// multipartLines is the part of GmailClient.buildMultipartMessage after the
// address headers: multipart/related for inline images, multipart/mixed for
// attachments, and mixed around related when there are both.
func (a *api) multipartLines(o *sendOptions) ([]string, error) {
	var inline, regular []attachmentFile
	for _, att := range o.attachments {
		if att.contentID != "" {
			inline = append(inline, att)
		} else {
			regular = append(regular, att)
		}
	}
	mixed, related := boundary("Mixed"), boundary("Related")
	lines := []string{"MIME-Version: 1.0"}
	part := func(b string, att attachmentFile) error {
		enc, err := a.encodeAttachment(att)
		if err != nil {
			return err
		}
		lines = append(lines, "--"+b, fmt.Sprintf(`Content-Type: %s; name="%s"`, enc.mimeType, enc.filename), "Content-Transfer-Encoding: base64")
		if att.contentID != "" {
			lines = append(lines, "Content-ID: <"+att.contentID+">", fmt.Sprintf(`Content-Disposition: inline; filename="%s"`, enc.filename))
		} else {
			lines = append(lines, fmt.Sprintf(`Content-Disposition: attachment; filename="%s"`, enc.filename))
		}
		lines = append(lines, "", enc.base64)
		return nil
	}
	relatedBlock := func() error {
		lines = append(lines, "--"+related, contentType(o.isHTML), "", o.body)
		for _, att := range inline {
			if err := part(related, att); err != nil {
				return err
			}
		}
		lines = append(lines, "--"+related+"--")
		return nil
	}
	switch {
	case len(inline) > 0 && len(regular) > 0:
		lines = append(lines, fmt.Sprintf(`Content-Type: multipart/mixed; boundary="%s"`, mixed), "",
			"--"+mixed, fmt.Sprintf(`Content-Type: multipart/related; boundary="%s"`, related), "")
		if err := relatedBlock(); err != nil {
			return nil, err
		}
		for _, att := range regular {
			if err := part(mixed, att); err != nil {
				return nil, err
			}
		}
		lines = append(lines, "--"+mixed+"--")
	case len(inline) > 0:
		lines = append(lines, fmt.Sprintf(`Content-Type: multipart/related; boundary="%s"`, related), "")
		if err := relatedBlock(); err != nil {
			return nil, err
		}
	default:
		lines = append(lines, fmt.Sprintf(`Content-Type: multipart/mixed; boundary="%s"`, mixed), "",
			"--"+mixed, contentType(o.isHTML), "", o.body)
		for _, att := range regular {
			if err := part(mixed, att); err != nil {
				return nil, err
			}
		}
		lines = append(lines, "--"+mixed+"--")
	}
	return lines, nil
}

// sendResult is send's { id, threadId, labelIds }.
type sendResult struct{ *jsvalue.Object }

func (a *api) send(o *sendOptions) (*sendResult, error) {
	raw, err := a.buildEncodedMessage(o)
	if err != nil {
		return nil, err
	}
	_, answer, err := google.Answer(a.Ctx, a.svc.Users.Messages.Send("me", &gmail.Message{Raw: raw, ThreadId: o.replyTo}))
	if err == nil && jsvalue.Nullish(answer) {
		err = jsvalue.TypeError(answer, "response.data.id")
	}
	if err != nil {
		return nil, a.APIError("Failed to send email", err)
	}
	return &sendResult{jsvalue.ObjectOf(
		"id", member(answer, "id"),
		"threadId", member(answer, "threadId"),
		"labelIds", jsvalue.Or(member(answer, "labelIds"), []any{"SENT"}),
	)}, nil
}

// draftResult is draft's and updateDraft's { id, messageId }.
type draftResult struct {
	*jsvalue.Object
	updated bool
}

// draftMissing is Bun's draft 404 test, on the message text.
func draftMissing(err error) bool {
	message := google.Message(err)
	return strings.Contains(message, "404") || strings.Contains(strings.ToLower(message), "not found")
}

func (a *api) draftNotFound(id string) error {
	return a.Fail("NOT_FOUND", "Draft not found: "+id, "Check the draft ID (use the ID returned when the draft was created).")
}

// saveDraft is GmailClient.draft, or GmailClient.updateDraft with an id.
func (a *api) saveDraft(id string, o *sendOptions) (*draftResult, error) {
	raw, err := a.buildEncodedMessage(o)
	if err != nil {
		return nil, err
	}
	draft := &gmail.Draft{Message: &gmail.Message{Raw: raw, ThreadId: o.replyTo}}
	var answer any
	if id == "" {
		_, answer, err = google.Answer(a.Ctx, a.svc.Users.Drafts.Create("me", draft))
	} else {
		_, answer, err = google.Answer(a.Ctx, a.svc.Users.Drafts.Update("me", id, draft))
	}
	if err == nil && jsvalue.Nullish(answer) {
		err = jsvalue.TypeError(answer, "response.data.id")
	}
	switch {
	case err != nil && id == "":
		return nil, a.APIError("Failed to create draft", err)
	case err != nil && draftMissing(err):
		return nil, a.draftNotFound(id)
	case err != nil:
		return nil, a.APIError("Failed to update draft", err)
	}
	return &draftResult{jsvalue.ObjectOf(
		"id", member(answer, "id"),
		"messageId", jsvalue.Or(jsvalue.Optional(member(answer, "message"), "id"), ""),
	), id != ""}, nil
}

func (a *api) deleteDraft(id string) error {
	if err := a.svc.Users.Drafts.Delete("me", id).Context(a.Ctx).Do(); err != nil {
		if draftMissing(err) {
			return a.draftNotFound(id)
		}
		return a.APIError("Failed to delete draft", err)
	}
	return nil
}

func (a *api) archive(id string) error {
	_, err := a.svc.Users.Messages.Modify("me", id, &gmail.ModifyMessageRequest{RemoveLabelIds: []string{"INBOX"}}).Context(a.Ctx).Do()
	if err != nil {
		return a.NotFoundOr("Message", id, "Failed to archive", err)
	}
	return nil
}

func (a *api) mark(id string, read bool) error {
	req := &gmail.ModifyMessageRequest{AddLabelIds: []string{"UNREAD"}}
	if read {
		req = &gmail.ModifyMessageRequest{RemoveLabelIds: []string{"UNREAD"}}
	}
	if _, err := a.svc.Users.Messages.Modify("me", id, req).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Message", id, "Failed to update message", err)
	}
	return nil
}

// mapLabel is GmailClient.mapLabel.
func mapLabel(l any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(l) {
		return nil, jsvalue.TypeError(l, "label.id")
	}
	kind := "user"
	if jsvalue.StrictEqual(member(l, "type"), "system") {
		kind = "system"
	}
	out := jsvalue.ObjectOf("id", member(l, "id"), "name", member(l, "name"), "type", kind)
	for _, k := range []string{"messageListVisibility", "labelListVisibility"} {
		if v := member(l, k); jsvalue.Truthy(v) {
			out.Set(k, v)
		}
	}
	return out, nil
}

// listLabels is GmailClient.listLabels: system labels first, then by
// localeCompare on the name.
func (a *api) listLabels() ([]*jsvalue.Object, error) {
	out, err := a.readLabels()
	if err != nil {
		return nil, a.APIError("Gmail API error", err)
	}
	return out, nil
}

func (a *api) readLabels() ([]*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Labels.List("me"))
	if err != nil {
		return nil, err
	}
	// Bun's transpiler inlines the one-use response in the expression it reports.
	labels, err := jsvalue.Path(raw, `(await this.gmail.users.labels.list({ userId: "me" })).data`, "labels")
	if err != nil {
		return nil, err
	}
	list, err := jsvalue.Items(jsvalue.Or(labels, []any{}), "(response.data.labels || [])")
	if err != nil {
		return nil, err
	}
	out := []*jsvalue.Object{}
	for _, l := range list {
		m, err := mapLabel(l)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	// `a.name.localeCompare(b.name)` throws when a has no name; which pairs
	// JavaScriptCore compares is its own, so only the message is Bun's.
	var sortErr error
	sort.SliceStable(out, func(i, j int) bool {
		ti, tj := member(out[i], "type"), member(out[j], "type")
		if ti != tj {
			return ti == "system"
		}
		name := member(out[i], "name")
		if jsvalue.Nullish(name) {
			if sortErr == nil {
				sortErr = jsvalue.TypeError(name, "a.name.localeCompare")
			}
			return false
		}
		return jsvalue.LocaleCompare(jsvalue.String(name), jsvalue.String(member(out[j], "name"))) < 0
	})
	if sortErr != nil {
		return nil, sortErr
	}
	return out, nil
}

// labelCreated is createLabel's GmailLabel.
type labelCreated struct{ *jsvalue.Object }

func (a *api) createLabel(name string) (*labelCreated, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Labels.Create("me", &gmail.Label{Name: name, MessageListVisibility: "show", LabelListVisibility: "labelShow"}))
	var l *jsvalue.Object
	if err == nil {
		l, err = mapLabel(raw)
	}
	if err != nil {
		return nil, a.APIError("Failed to create label", err)
	}
	return &labelCreated{l}, nil
}

// lowerName is `l.name.toLowerCase()`.
func lowerName(l *jsvalue.Object) (string, error) {
	name := member(l, "name")
	if jsvalue.Nullish(name) {
		return "", jsvalue.TypeError(name, "l.name.toLowerCase")
	}
	return strings.ToLower(jsvalue.String(name)), nil
}

// resolveLabel finds a label by id, else by name without regard to case.
func (a *api) resolveLabel(nameOrID string) (*jsvalue.Object, error) {
	labels, err := a.listLabels()
	if err != nil {
		return nil, err
	}
	for _, l := range labels {
		if jsvalue.StrictEqual(member(l, "id"), nameOrID) {
			return l, nil
		}
	}
	for _, l := range labels {
		name, err := lowerName(l)
		if err != nil {
			return nil, err
		}
		if name == strings.ToLower(nameOrID) {
			return l, nil
		}
	}
	return nil, a.Fail("NOT_FOUND", "Label not found: "+nameOrID, "")
}

// labelDeleted is deleteLabel's { id, name }.
type labelDeleted struct{ *jsvalue.Object }

func (a *api) deleteLabel(nameOrID string) (*labelDeleted, error) {
	l, err := a.resolveLabel(nameOrID)
	if err != nil {
		return nil, err
	}
	if member(l, "type") == "system" {
		return nil, a.Fail("INVALID_PARAMS", "Cannot delete system label: "+google.Field(l, "name"), "")
	}
	if err := a.svc.Users.Labels.Delete("me", google.Field(l, "id")).Context(a.Ctx).Do(); err != nil {
		return nil, a.APIError("Failed to delete label", err)
	}
	return &labelDeleted{jsvalue.ObjectOf("id", member(l, "id"), "name", member(l, "name"))}, nil
}

func (a *api) renameLabel(oldNameOrID, newName string) (*jsvalue.Object, error) {
	l, err := a.resolveLabel(oldNameOrID)
	if err != nil {
		return nil, err
	}
	if member(l, "type") == "system" {
		return nil, a.Fail("INVALID_PARAMS", "Cannot rename system label: "+google.Field(l, "name"), "")
	}
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Labels.Patch("me", google.Field(l, "id"), &gmail.Label{Name: newName}))
	var patched *jsvalue.Object
	if err == nil {
		patched, err = mapLabel(raw)
	}
	if err != nil {
		return nil, a.APIError("Failed to rename label", err)
	}
	return patched, nil
}

// resolveLabelIDs is GmailClient.resolveLabelIds. Its name index is a Map
// built in list order, so the last label with a name wins.
func (a *api) resolveLabelIDs(namesOrIDs []string) ([]string, error) {
	if len(namesOrIDs) == 0 {
		return []string{}, nil
	}
	labels, err := a.listLabels()
	if err != nil {
		return nil, err
	}
	byID := map[string]*jsvalue.Object{}
	for _, l := range labels {
		if id, ok := member(l, "id").(string); ok {
			byID[id] = l
		}
	}
	byName := map[string]*jsvalue.Object{}
	for _, l := range labels {
		name, err := lowerName(l)
		if err != nil {
			return nil, err
		}
		byName[name] = l
	}
	out := make([]string, len(namesOrIDs))
	for i, input := range namesOrIDs {
		if l, ok := byID[input]; ok {
			out[i] = google.Field(l, "id")
		} else if l, ok := byName[strings.ToLower(input)]; ok {
			out[i] = google.Field(l, "id")
		} else {
			return nil, a.Fail("NOT_FOUND", "Label not found: "+input, "")
		}
	}
	return out, nil
}

// modifyLabels is GmailClient.modifyLabels on one message.
func (a *api) modifyLabels(id string, add, remove []string) error {
	req := &gmail.ModifyMessageRequest{AddLabelIds: add, RemoveLabelIds: remove}
	if _, err := a.svc.Users.Messages.Modify("me", id, req).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Message", id, "Failed to modify labels", err)
	}
	return nil
}

// withRetry is Bun retryWithBackoff around one googleapis call; it returns
// the call's own last error.
func withRetry(maxRetries int, call func() error) error {
	var last error
	err := retry.Do(func() error {
		last = call()
		if last == nil {
			return nil
		}
		return &retry.StatusError{Status: google.Code(last), Message: google.Message(last)}
	}, retry.Options{MaxRetries: maxRetries, Sleep: retrySleep})
	if err != nil {
		return last
	}
	return nil
}

// expandThreads is GmailClient.expandThreadsToMessages: 8 workers, a missing
// thread skipped. Message ids keep the thread order.
func (a *api) expandThreads(threadIDs []string, maxRetries int) ([]string, error) {
	perThread := make([][]string, len(threadIDs))
	var (
		mu       sync.Mutex
		firstErr error
		next     int
		wg       sync.WaitGroup
	)
	fail := func(err error) {
		mu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		mu.Unlock()
	}
	worker := func() {
		defer wg.Done()
		for {
			mu.Lock()
			if firstErr != nil || next >= len(threadIDs) {
				mu.Unlock()
				return
			}
			idx := next
			next++
			mu.Unlock()
			id := threadIDs[idx]
			var raw any
			err := withRetry(maxRetries, func() error {
				var err error
				_, raw, err = google.Answer(a.Ctx, a.svc.Users.Threads.Get("me", id).Format("minimal"))
				return err
			})
			if err != nil {
				if google.IsNotFound(err) {
					continue
				}
				fail(a.APIError("Failed to expand thread "+id, err))
				return
			}
			messages, err := jsvalue.Path(raw, "response.data", "messages")
			if err != nil {
				fail(a.APIError("Failed to expand thread "+id, err))
				return
			}
			for _, m := range items(messages) {
				if jsvalue.Nullish(m) {
					fail(a.APIError("Failed to expand thread "+id, jsvalue.TypeError(m, "m.id")))
					return
				}
				if mid := member(m, "id"); jsvalue.Truthy(mid) {
					perThread[idx] = append(perThread[idx], jsvalue.String(mid))
				}
			}
		}
	}
	workers := min(8, len(threadIDs))
	wg.Add(workers)
	for range workers {
		go worker()
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	out := []string{}
	for _, ids := range perThread {
		out = append(out, ids...)
	}
	return out, nil
}

// batchModify is GmailClient.batchModify: chunks of up to 1000 ids, each
// retried, a failed chunk recorded and the rest still sent.
func (a *api) batchModify(action string, ids, add, remove []string, chunkSize, maxRetries int) *batchResult {
	chunkSize = min(max(chunkSize, 1), 1000)
	out := &batchResult{action: action, TotalIDs: len(ids), Failed: []failedChunk{}}
	if len(ids) == 0 || (len(add) == 0 && len(remove) == 0) {
		return out
	}
	var chunks [][]string
	for i := 0; i < len(ids); i += chunkSize {
		chunks = append(chunks, ids[i:min(i+chunkSize, len(ids))])
	}
	out.Chunks = len(chunks)
	for i, batch := range chunks {
		started := now()
		err := withRetry(maxRetries, func() error {
			return a.svc.Users.Messages.BatchModify("me", &gmail.BatchModifyMessagesRequest{Ids: batch, AddLabelIds: add, RemoveLabelIds: remove}).Context(a.Ctx).Do()
		})
		tag := fmt.Sprintf("[%s] chunk %d/%d (%d ids)", action, i+1, len(chunks), len(batch))
		elapsed := now().Sub(started).Milliseconds()
		if err == nil {
			out.OK += len(batch)
			a.Log(fmt.Sprintf("%s ok in %dms", tag, elapsed))
			continue
		}
		reason := google.Message(err)
		out.Failed = append(out.Failed, failedChunk{IDs: batch, Reason: reason})
		a.Log(fmt.Sprintf("%s FAILED in %dms: %s", tag, elapsed, reason))
	}
	return out
}

// mapFilter is GmailClient.mapFilter.
func mapFilter(f any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(f) {
		return nil, jsvalue.TypeError(f, "filter.criteria")
	}
	rc := jsvalue.Or(member(f, "criteria"), jsvalue.NewObject())
	criteria := jsvalue.NewObject()
	for _, k := range []string{"from", "to", "subject", "query", "negatedQuery"} {
		if v := member(rc, k); jsvalue.Truthy(v) {
			criteria.Set(k, v)
		}
	}
	for _, k := range []string{"hasAttachment", "excludeChats"} {
		if jsvalue.Truthy(member(rc, k)) {
			criteria.Set(k, true)
		}
	}
	if size := member(rc, "size"); isNumber(size) {
		criteria.Set("size", size)
	}
	if c := member(rc, "sizeComparison"); c == "larger" || c == "smaller" {
		criteria.Set("sizeComparison", c)
	}
	ra := jsvalue.Or(member(f, "action"), jsvalue.NewObject())
	action := jsvalue.NewObject()
	for _, k := range []string{"addLabelIds", "removeLabelIds"} {
		if v := member(ra, k); jsvalue.Truthy(jsvalue.Optional(v, "length")) {
			action.Set(k, v)
		}
	}
	if v := member(ra, "forward"); jsvalue.Truthy(v) {
		action.Set("forward", v)
	}
	return jsvalue.ObjectOf("id", member(f, "id"), "criteria", criteria, "action", action), nil
}

// isNumber is `typeof v === 'number'` for a value read from an answer.
func isNumber(v any) bool {
	switch v.(type) {
	case json.Number, float64, int, int64:
		return true
	}
	return false
}

func (a *api) listFilters() ([]*jsvalue.Object, error) {
	out, err := a.readFilters()
	if err != nil {
		return nil, a.APIError("Gmail API error", err)
	}
	return out, nil
}

func (a *api) readFilters() ([]*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Settings.Filters.List("me"))
	if err != nil {
		return nil, err
	}
	filters, err := jsvalue.Path(raw, `(await this.gmail.users.settings.filters.list({ userId: "me" })).data`, "filter")
	if err != nil {
		return nil, err
	}
	list, err := jsvalue.Items(jsvalue.Or(filters, []any{}), "(response.data.filter || [])")
	if err != nil {
		return nil, err
	}
	out := []*jsvalue.Object{}
	for _, f := range list {
		m, err := mapFilter(f)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func (a *api) getFilter(id string) (*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Settings.Filters.Get("me", id))
	var out *jsvalue.Object
	if err == nil {
		out, err = mapFilter(raw)
	}
	if err != nil {
		return nil, a.NotFoundOr("Filter", id, "Gmail API error", err)
	}
	return out, nil
}

func (a *api) createFilter(c filterCriteria, act filterAction) (*jsvalue.Object, error) {
	criteria := &gmail.FilterCriteria{
		From: c.From, To: c.To, Subject: c.Subject, Query: c.Query, NegatedQuery: c.NegatedQuery,
		HasAttachment: c.HasAttachment, ExcludeChats: c.ExcludeChats, SizeComparison: c.SizeComparison,
	}
	if c.Size != nil {
		criteria.Size = *c.Size
		criteria.ForceSendFields = []string{"Size"}
	}
	body := &gmail.Filter{Criteria: criteria, Action: &gmail.FilterAction{AddLabelIds: act.AddLabelIDs, RemoveLabelIds: act.RemoveLabelIDs, Forward: act.Forward}}
	_, raw, err := google.Answer(a.Ctx, a.svc.Users.Settings.Filters.Create("me", body))
	var out *jsvalue.Object
	if err == nil {
		out, err = mapFilter(raw)
	}
	if err != nil {
		return nil, a.APIError("Failed to create filter", err)
	}
	return out, nil
}

func (a *api) deleteFilter(id string) error {
	if err := a.svc.Users.Settings.Filters.Delete("me", id).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Filter", id, "Failed to delete filter", err)
	}
	return nil
}

// labelNamesByID is Bun buildLabelNamesById: label id to name, the name as
// the label has it (resolveLabelNames falls back to the id when it is null
// or undefined).
func (a *api) labelNamesByID() (map[string]any, error) {
	labels, err := a.listLabels()
	if err != nil {
		return nil, err
	}
	out := make(map[string]any, len(labels))
	for _, l := range labels {
		if id, ok := member(l, "id").(string); ok {
			out[id] = member(l, "name")
		}
	}
	return out, nil
}

// writeFile is Bun.write: missing parent directories are created.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
