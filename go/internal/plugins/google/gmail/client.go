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
	"net/url"
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

type attachmentInfo struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	MimeType string `json:"mimeType"`
	Size     int64  `json:"size"`
}

// message is GmailMessage. get adds the attachments (when there are any) and
// the body, in that order, as Bun's `{ ...message, body }` does.
type message struct {
	ID          string            `json:"id"`
	ThreadID    string            `json:"threadId"`
	Subject     string            `json:"subject"`
	From        string            `json:"from"`
	To          []string          `json:"to"`
	Cc          []string          `json:"cc"`
	Date        string            `json:"date"`
	Snippet     string            `json:"snippet"`
	Labels      []string          `json:"labels"`
	Attachments *[]attachmentInfo `json:"attachments,omitempty"`
	Body        *string           `json:"body,omitempty"`
}

type messageList struct {
	Messages []message `json:"messages"`
	Total    int64     `json:"total"`
}

type label struct {
	ID                    string `json:"id"`
	Name                  string `json:"name"`
	Type                  string `json:"type"`
	MessageListVisibility string `json:"messageListVisibility,omitempty"`
	LabelListVisibility   string `json:"labelListVisibility,omitempty"`
}

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

type filter struct {
	ID       string         `json:"id"`
	Criteria filterCriteria `json:"criteria"`
	Action   filterAction   `json:"action"`
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

// thrown is a googleapis error Bun does not catch: handleError prints its
// message without a code.
func thrown(err error) error {
	return errors.New(google.Message(err))
}

// getUserEmail is GmailClient.getUserEmail: the profile address, else "me".
func (a *api) getUserEmail() (string, error) {
	if a.userEmail != "" {
		return a.userEmail, nil
	}
	p, err := a.svc.Users.GetProfile("me").Context(a.Ctx).Do()
	if err != nil {
		return "", err
	}
	a.userEmail = p.EmailAddress
	if a.userEmail == "" {
		a.userEmail = "me"
	}
	return a.userEmail, nil
}

// parseHeaders lower-cases header names; a later header wins, an empty one is skipped.
func parseHeaders(headers []*gmail.MessagePartHeader) map[string]string {
	out := map[string]string{}
	for _, h := range headers {
		if h != nil && h.Name != "" && h.Value != "" {
			out[strings.ToLower(h.Name)] = h.Value
		}
	}
	return out
}

func extractAttachments(payload *gmail.MessagePart) []attachmentInfo {
	out := []attachmentInfo{}
	var walk func(p *gmail.MessagePart)
	walk = func(p *gmail.MessagePart) {
		if p.Filename != "" && p.Body != nil && p.Body.AttachmentId != "" {
			mime := p.MimeType
			if mime == "" {
				mime = "application/octet-stream"
			}
			out = append(out, attachmentInfo{ID: p.Body.AttachmentId, Filename: p.Filename, MimeType: mime, Size: p.Body.Size})
		}
		for _, child := range p.Parts {
			if child != nil {
				walk(child)
			}
		}
	}
	if payload != nil {
		walk(payload)
	}
	return out
}

func addresses(value string) []string {
	if value == "" {
		return []string{}
	}
	parts := strings.Split(value, ",")
	for i, p := range parts {
		parts[i] = jsvalue.Trim(p)
	}
	return parts
}

func parseMessage(m *gmail.Message, withAttachments bool) message {
	var headers map[string]string
	if m.Payload != nil {
		headers = parseHeaders(m.Payload.Headers)
	}
	labels := m.LabelIds
	if labels == nil {
		labels = []string{}
	}
	out := message{
		ID:       m.Id,
		ThreadID: m.ThreadId,
		Subject:  cmp.Or(headers["subject"], "(no subject)"),
		From:     headers["from"],
		To:       addresses(headers["to"]),
		Cc:       addresses(headers["cc"]),
		Date:     headers["date"],
		Snippet:  m.Snippet,
		Labels:   labels,
	}
	if withAttachments {
		if atts := extractAttachments(m.Payload); len(atts) > 0 {
			out.Attachments = &atts
		}
	}
	return out
}

// decodeBody is Buffer.from(data, 'base64').toString('utf-8').
func decodeBody(data string) string {
	return jsvalue.BufferString(jsvalue.DecodeBase64(data))
}

// bodyOf is GmailClient.getBody: the first part of the preferred type, else
// of the other one. An empty decode counts as not found, as in Bun.
func bodyOf(payload *gmail.MessagePart, preferHTML bool) string {
	if payload == nil {
		return ""
	}
	var find func(p *gmail.MessagePart, mime string) string
	find = func(p *gmail.MessagePart, mime string) string {
		if p.MimeType == mime && p.Body != nil && p.Body.Data != "" {
			return decodeBody(p.Body.Data)
		}
		for _, child := range p.Parts {
			if child == nil {
				continue
			}
			if r := find(child, mime); r != "" {
				return r
			}
		}
		return ""
	}
	target, fallback := "text/plain", "text/html"
	if preferHTML {
		target, fallback = fallback, target
	}
	if r := find(payload, target); r != "" {
		return r
	}
	return find(payload, fallback)
}

// list is GmailClient.list: ids page by page up to the capped limit, then
// metadata for each when the limit is 100 or less.
func (a *api) list(limit float64, query string, labels []string) (*messageList, error) {
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

	type ref struct{ id, threadID string }
	var ids []ref
	var total int64
	pageToken := ""
	for float64(len(ids)) < capped {
		remaining := capped - float64(len(ids))
		call := a.svc.Users.Messages.List("me").MaxResults(int64(math.Min(remaining, 500))).Context(a.Ctx)
		if q != "" {
			call.Q(q)
		}
		if pageToken != "" {
			call.PageToken(pageToken)
		}
		resp, err := call.Do()
		if err != nil {
			return nil, a.APIError("Gmail API error", err)
		}
		if total == 0 {
			total = resp.ResultSizeEstimate
		}
		for _, m := range resp.Messages {
			if m != nil && m.Id != "" && m.ThreadId != "" {
				ids = append(ids, ref{m.Id, m.ThreadId})
				if float64(len(ids)) >= capped {
					break
				}
			}
		}
		pageToken = resp.NextPageToken
		if pageToken == "" {
			break
		}
	}

	out := &messageList{Messages: []message{}}
	for _, r := range ids {
		if !withMetadata {
			out.Messages = append(out.Messages, message{ID: r.id, ThreadID: r.threadID, To: []string{}, Cc: []string{}, Labels: []string{}})
			continue
		}
		m, err := a.svc.Users.Messages.Get("me", r.id).Format("metadata").
			MetadataHeaders("From", "To", "Cc", "Subject", "Date").Context(a.Ctx).Do()
		if err != nil {
			return nil, a.APIError("Gmail API error", err)
		}
		out.Messages = append(out.Messages, parseMessage(m, false))
	}
	out.Total = total
	if out.Total == 0 {
		out.Total = int64(len(out.Messages))
	}
	return out, nil
}

// get is GmailClient.get. format is Bun's text, html or raw; anything else
// reads like text.
func (a *api) get(id, format string) (*message, error) {
	apiFormat := "full"
	if format == "raw" {
		apiFormat = "raw"
	}
	m, err := a.svc.Users.Messages.Get("me", id).Format(apiFormat).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.NotFoundOr("Message", id, "Gmail API error", err)
	}
	out := parseMessage(m, true)
	var body string
	if format == "raw" {
		if m.Raw != "" {
			body = decodeBody(m.Raw)
		}
	} else {
		body = bodyOf(m.Payload, format == "html")
	}
	out.Body = &body
	return &out, nil
}

type downloaded struct {
	data       []byte
	attachment attachmentInfo
}

// allAttachments is GmailClient.getAllAttachments.
func (a *api) allAttachments(id string) ([]downloaded, error) {
	m, err := a.svc.Users.Messages.Get("me", id).Format("full").Context(a.Ctx).Do()
	if err != nil {
		return nil, a.NotFoundOr("Message", id, "Gmail API error", err)
	}
	out := []downloaded{}
	for _, att := range extractAttachments(m.Payload) {
		body, err := a.svc.Users.Messages.Attachments.Get("me", id, att.ID).Context(a.Ctx).Do()
		if err != nil {
			return nil, a.NotFoundOr("Message", id, "Gmail API error", err)
		}
		if body.Data != "" {
			out = append(out, downloaded{data: jsvalue.DecodeBase64(body.Data), attachment: att})
		}
	}
	return out, nil
}

// replyContext is GmailClient.resolveReplyContext: the last message of the
// thread gives the recipient, the subject and the threading headers.
func (a *api) replyContext(threadID string) (to []string, subject string, extra []string, err error) {
	thread, err := a.svc.Users.Threads.Get("me", threadID).Context(a.Ctx).Do()
	if err != nil {
		return nil, "", nil, thrown(err)
	}
	if len(thread.Messages) == 0 {
		return nil, "", nil, a.Fail("NOT_FOUND", "Thread not found: "+threadID, "")
	}
	last := thread.Messages[len(thread.Messages)-1]
	var headers map[string]string
	if last.Payload != nil {
		headers = parseHeaders(last.Payload.Headers)
	}
	to = []string{cmp.Or(headers["reply-to"], headers["from"])}
	subject = headers["subject"]
	if !strings.HasPrefix(subject, "Re:") {
		subject = "Re: " + cmp.Or(subject, "(no subject)")
	}
	if id := headers["message-id"]; id != "" {
		extra = []string{"In-Reply-To: " + id, "References: " + id}
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

type sendResult struct {
	ID       string   `json:"id"`
	ThreadID string   `json:"threadId"`
	LabelIDs []string `json:"labelIds"`
}

func (a *api) send(o *sendOptions) (*sendResult, error) {
	raw, err := a.buildEncodedMessage(o)
	if err != nil {
		return nil, err
	}
	m, err := a.svc.Users.Messages.Send("me", &gmail.Message{Raw: raw, ThreadId: o.replyTo}).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.APIError("Failed to send email", err)
	}
	labels := m.LabelIds
	if labels == nil {
		labels = []string{"SENT"}
	}
	return &sendResult{ID: m.Id, ThreadID: m.ThreadId, LabelIDs: labels}, nil
}

type draftResult struct {
	ID        string `json:"id"`
	MessageID string `json:"messageId"`
	updated   bool
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
	var d *gmail.Draft
	if id == "" {
		d, err = a.svc.Users.Drafts.Create("me", draft).Context(a.Ctx).Do()
		if err != nil {
			return nil, a.APIError("Failed to create draft", err)
		}
	} else {
		d, err = a.svc.Users.Drafts.Update("me", id, draft).Context(a.Ctx).Do()
		if err != nil {
			if draftMissing(err) {
				return nil, a.draftNotFound(id)
			}
			return nil, a.APIError("Failed to update draft", err)
		}
	}
	out := &draftResult{ID: d.Id, updated: id != ""}
	if d.Message != nil {
		out.MessageID = d.Message.Id
	}
	return out, nil
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

func mapLabel(l *gmail.Label) label {
	kind := "user"
	if l.Type == "system" {
		kind = "system"
	}
	return label{ID: l.Id, Name: l.Name, Type: kind, MessageListVisibility: l.MessageListVisibility, LabelListVisibility: l.LabelListVisibility}
}

// listLabels is GmailClient.listLabels: system labels first, then by
// localeCompare on the name.
func (a *api) listLabels() ([]label, error) {
	resp, err := a.svc.Users.Labels.List("me").Context(a.Ctx).Do()
	if err != nil {
		return nil, a.APIError("Gmail API error", err)
	}
	out := []label{}
	for _, l := range resp.Labels {
		if l != nil {
			out = append(out, mapLabel(l))
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == "system"
		}
		return jsvalue.LocaleCompare(out[i].Name, out[j].Name) < 0
	})
	return out, nil
}

func (a *api) createLabel(name string) (*label, error) {
	l, err := a.svc.Users.Labels.Create("me", &gmail.Label{Name: name, MessageListVisibility: "show", LabelListVisibility: "labelShow"}).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.APIError("Failed to create label", err)
	}
	out := mapLabel(l)
	return &out, nil
}

// resolveLabel finds a label by id, else by name without regard to case.
func (a *api) resolveLabel(nameOrID string) (*label, error) {
	labels, err := a.listLabels()
	if err != nil {
		return nil, err
	}
	for i := range labels {
		if labels[i].ID == nameOrID {
			return &labels[i], nil
		}
	}
	for i := range labels {
		if strings.ToLower(labels[i].Name) == strings.ToLower(nameOrID) {
			return &labels[i], nil
		}
	}
	return nil, a.Fail("NOT_FOUND", "Label not found: "+nameOrID, "")
}

type labelDeleted struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (a *api) deleteLabel(nameOrID string) (*labelDeleted, error) {
	l, err := a.resolveLabel(nameOrID)
	if err != nil {
		return nil, err
	}
	if l.Type == "system" {
		return nil, a.Fail("INVALID_PARAMS", "Cannot delete system label: "+l.Name, "")
	}
	if err := a.svc.Users.Labels.Delete("me", l.ID).Context(a.Ctx).Do(); err != nil {
		return nil, a.APIError("Failed to delete label", err)
	}
	return &labelDeleted{ID: l.ID, Name: l.Name}, nil
}

func (a *api) renameLabel(oldNameOrID, newName string) (*label, error) {
	l, err := a.resolveLabel(oldNameOrID)
	if err != nil {
		return nil, err
	}
	if l.Type == "system" {
		return nil, a.Fail("INVALID_PARAMS", "Cannot rename system label: "+l.Name, "")
	}
	patched, err := a.svc.Users.Labels.Patch("me", l.ID, &gmail.Label{Name: newName}).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.APIError("Failed to rename label", err)
	}
	out := mapLabel(patched)
	return &out, nil
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
	byID := map[string]string{}
	byName := map[string]string{}
	for _, l := range labels {
		byID[l.ID] = l.ID
		byName[strings.ToLower(l.Name)] = l.ID
	}
	out := make([]string, len(namesOrIDs))
	for i, input := range namesOrIDs {
		if id, ok := byID[input]; ok {
			out[i] = id
		} else if id, ok := byName[strings.ToLower(input)]; ok {
			out[i] = id
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
			var thread *gmail.Thread
			err := withRetry(maxRetries, func() error {
				var err error
				thread, err = a.svc.Users.Threads.Get("me", id).Format("minimal").Context(a.Ctx).Do()
				return err
			})
			if err != nil {
				if google.IsNotFound(err) {
					continue
				}
				mu.Lock()
				if firstErr == nil {
					firstErr = a.APIError("Failed to expand thread "+id, err)
				}
				mu.Unlock()
				return
			}
			for _, m := range thread.Messages {
				if m != nil && m.Id != "" {
					perThread[idx] = append(perThread[idx], m.Id)
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

// mapFilter is GmailClient.mapFilter on the API's own JSON: the typed
// gmail.Filter cannot tell a size of 0 from no size, and Bun keeps any number.
func mapFilter(raw any) filter {
	o, _ := raw.(*jsvalue.Object)
	id, _ := o.Str("id")
	out := filter{ID: id}
	c, _ := field(o, "criteria").(*jsvalue.Object)
	out.Criteria = filterCriteria{
		From: str(c, "from"), To: str(c, "to"), Subject: str(c, "subject"), Query: str(c, "query"), NegatedQuery: str(c, "negatedQuery"),
		HasAttachment: jsvalue.Truthy(field(c, "hasAttachment")), ExcludeChats: jsvalue.Truthy(field(c, "excludeChats")),
	}
	if n, ok := field(c, "size").(json.Number); ok {
		size, _ := n.Float64()
		v := int64(size)
		out.Criteria.Size = &v
	}
	if cmp, _ := c.Str("sizeComparison"); cmp == "larger" || cmp == "smaller" {
		out.Criteria.SizeComparison = cmp
	}
	act, _ := field(o, "action").(*jsvalue.Object)
	out.Action = filterAction{AddLabelIDs: labelIDs(field(act, "addLabelIds")), RemoveLabelIDs: labelIDs(field(act, "removeLabelIds")), Forward: str(act, "forward")}
	return out
}

func field(o *jsvalue.Object, key string) any {
	v, _ := o.Get(key)
	return v
}

func str(o *jsvalue.Object, key string) string {
	s, _ := o.Str(key)
	return s
}

// labelIDs is a non-empty array of label ids, else nil (Bun's `?.length`).
func labelIDs(v any) []string {
	items, _ := v.([]any)
	var out []string
	for _, item := range items {
		s, _ := item.(string)
		out = append(out, s)
	}
	return out
}

// filtersCall is users.settings.filters under the client's base path, so
// test endpoints apply.
func (a *api) filtersCall(method, suffix string, body []byte) (any, error) {
	return google.CallJSON(a.Ctx, a.RunContext, google.Snake, method, a.svc.BasePath, "gmail/v1/users/me/settings/filters"+suffix, body)
}

func (a *api) listFilters() ([]filter, error) {
	resp, err := a.filtersCall("GET", "", nil)
	if err != nil {
		return nil, a.APIError("Gmail API error", err)
	}
	o, _ := resp.(*jsvalue.Object)
	out := []filter{}
	items, _ := field(o, "filter").([]any)
	for _, f := range items {
		out = append(out, mapFilter(f))
	}
	return out, nil
}

func (a *api) getFilter(id string) (*filter, error) {
	resp, err := a.filtersCall("GET", "/"+url.PathEscape(id), nil)
	if err != nil {
		return nil, a.NotFoundOr("Filter", id, "Gmail API error", err)
	}
	out := mapFilter(resp)
	return &out, nil
}

func (a *api) createFilter(c filterCriteria, act filterAction) (*filter, error) {
	body, err := json.Marshal(struct {
		Criteria filterCriteria `json:"criteria"`
		Action   filterAction   `json:"action"`
	}{c, act})
	if err != nil {
		return nil, err
	}
	resp, err := a.filtersCall("POST", "", body)
	if err != nil {
		return nil, a.APIError("Failed to create filter", err)
	}
	out := mapFilter(resp)
	return &out, nil
}

func (a *api) deleteFilter(id string) error {
	if err := a.svc.Users.Settings.Filters.Delete("me", id).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Filter", id, "Failed to delete filter", err)
	}
	return nil
}

// labelNamesByID is Bun buildLabelNamesById.
func (a *api) labelNamesByID() (map[string]string, error) {
	labels, err := a.listLabels()
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(labels))
	for _, l := range labels {
		out[l.ID] = l.Name
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
