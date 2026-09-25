package gmail

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// The command results. Each renders as Bun's output.ts printer for it; the
// host prints the same value as JSON for --json.
type (
	idList         []string
	draftsDeleted  []string
	filtersDeleted []string
	labelList      []*jsvalue.Object
	markedList     []marked
	noMessages     struct{}
	noAttachments  struct{}
)

type marked struct {
	ID   string `json:"id"`
	Read bool   `json:"read"`
}

type archived struct {
	ID string `json:"id"`
}

type labelRenamed struct {
	Old   string          `json:"old"`
	Label *jsvalue.Object `json:"label"`
}

type labelModified struct {
	ID      string   `json:"id"`
	Applied []string `json:"applied"`
	Removed []string `json:"removed"`
}

// dryRunPlan is printBatchDryRun's plan.
type dryRunPlan struct {
	Action       string   `json:"-"`
	TotalIDs     int      `json:"totalIds"`
	ChunkSize    int      `json:"chunkSize"`
	Chunks       int      `json:"chunks"`
	AddLabels    []string `json:"addLabels"`
	RemoveLabels []string `json:"removeLabels"`
}

type downloadedFile struct {
	Filename string `json:"filename"`
	Path     string `json:"path"`
	Size     int    `json:"size"`
}

type downloads struct {
	Count int              `json:"-"`
	Files []downloadedFile `json:"files"`
}

type exported struct {
	Output string `json:"output"`
}

// filterListing, filterView and filterCreated carry the label names Bun
// resolves the filter actions with; their JSON is the filters alone.
type filterListing struct {
	filters []*jsvalue.Object
	names   map[string]any
}

func (f *filterListing) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(f.filters), nil }

type filterView struct {
	filter *jsvalue.Object
	names  map[string]any
}

func (f *filterView) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(f.filter), nil }

type filterCreated struct {
	filter *jsvalue.Object
	names  map[string]any
}

func (f *filterCreated) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(f.filter), nil }

// render is the Format of every gmail command.
func render(v any) string {
	switch r := v.(type) {
	case *messageList:
		return formatMessageList(r)
	case *message:
		return formatMessage(r)
	case string:
		return r
	case idList:
		return strings.Join(r, "\n")
	case *sendResult:
		return "Message sent\nID: " + google.Field(r.Object, "id") + "\nThread: " + google.Field(r.Object, "threadId")
	case *draftResult:
		verb := "Draft created"
		if r.updated {
			verb = "Draft updated"
		}
		return verb + "\nDraft ID: " + google.Field(r.Object, "id") + "\nMessage ID: " + google.Field(r.Object, "messageId")
	case draftsDeleted:
		return prefixed("Deleted draft: ", r)
	case filtersDeleted:
		return prefixed("Deleted filter: ", r)
	case archived:
		return "Archived: " + r.ID
	case markedList:
		lines := make([]string, len(r))
		for i, m := range r {
			state := "unread"
			if m.Read {
				state = "read"
			}
			lines[i] = fmt.Sprintf("Marked %s as %s", m.ID, state)
		}
		return strings.Join(lines, "\n")
	case *dryRunPlan:
		return formatDryRun(r)
	case *batchResult:
		return formatBatchSummary(r)
	case labelList:
		return formatLabelList(r)
	case *labelCreated:
		return "Created label: " + google.Field(r.Object, "name") + "\nID: " + google.Field(r.Object, "id")
	case *labelDeleted:
		return fmt.Sprintf("Deleted label: %s (%s)", google.Field(r.Object, "name"), google.Field(r.Object, "id"))
	case *labelRenamed:
		return "Renamed label: " + r.Old + " -> " + google.Field(r.Label, "name") + "\nID: " + google.Field(r.Label, "id")
	case *labelModified:
		return formatLabelModified(r)
	case noMessages:
		return "label: 0 message(s) to modify"
	case *filterListing:
		text, _ := formatFilterList(r.filters, r.names)
		return text
	case *filterView:
		text, _ := formatFilter(r.filter, r.names)
		return text
	case *filterCreated:
		text, _ := formatFilterCreated(r.filter, r.names)
		return text
	case noAttachments:
		return "No attachments found"
	case *downloads:
		return formatDownloads(r)
	case exported:
		return "Exported to " + r.Output
	}
	return ""
}

func prefixed(prefix string, ids []string) string {
	lines := make([]string, len(ids))
	for i, id := range ids {
		lines[i] = prefix + id
	}
	return strings.Join(lines, "\n")
}

// join is Array.prototype.join on an answer's array: null and undefined
// elements are empty.
func join(v any, sep string) string {
	list, ok := v.([]any)
	if !ok {
		return jsvalue.String(v)
	}
	return jsvalue.Join(list, sep)
}

// formatMessageList is printMessageList.
func formatMessageList(l *messageList) string {
	messages := items(member(l.Object, "messages"))
	lines := []string{fmt.Sprintf("Messages (%d of ~%s)", len(messages), google.Field(l.Object, "total")), ""}
	for i, m := range messages {
		lines = append(lines, fmt.Sprintf("[%d] %s | thread:%s", i+1, google.Field(m, "id"), google.Field(m, "threadId")))
		if google.Truthy(m, "from") {
			lines = append(lines, "    From: "+google.Field(m, "from"))
		}
		if google.Truthy(member(m, "to"), "length") {
			lines = append(lines, "    To: "+join(member(m, "to"), ", "))
		}
		if google.Truthy(m, "date") {
			lines = append(lines, "    Date: "+google.Field(m, "date"))
		}
		if google.Truthy(m, "subject") {
			lines = append(lines, "    Subject: "+google.Field(m, "subject"))
		}
		if google.Truthy(member(m, "labels"), "length") {
			lines = append(lines, "    Labels: "+join(member(m, "labels"), ", "))
		}
		if google.Truthy(m, "snippet") {
			lines = append(lines, "    > "+google.Field(m, "snippet"))
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

// formatMessage is printMessage.
func formatMessage(r *message) string {
	m := r.Object
	lines := []string{"ID: " + google.Field(m, "id"), "Thread: " + google.Field(m, "threadId"), "From: " + google.Field(m, "from")}
	if google.Truthy(member(m, "to"), "length") {
		lines = append(lines, "To: "+join(member(m, "to"), ", "))
	}
	if google.Truthy(member(m, "cc"), "length") {
		lines = append(lines, "CC: "+join(member(m, "cc"), ", "))
	}
	lines = append(lines, "Date: "+google.Field(m, "date"), "Subject: "+google.Field(m, "subject"))
	if google.Truthy(member(m, "labels"), "length") {
		lines = append(lines, "Labels: "+join(member(m, "labels"), ", "))
	}
	if atts := items(member(m, "attachments")); len(atts) > 0 {
		lines = append(lines, fmt.Sprintf("Attachments: %d", len(atts)))
		for _, att := range atts {
			lines = append(lines, fmt.Sprintf("  - %s (%s) [%s]", google.Field(att, "filename"), google.FormatBytes(member(att, "size")), google.Field(att, "id")))
		}
	}
	lines = append(lines, "---", google.Field(m, "body"))
	return strings.Join(lines, "\n")
}

// formatDryRun is printBatchDryRun.
func formatDryRun(p *dryRunPlan) string {
	lines := []string{
		"[dry-run] " + p.Action,
		fmt.Sprintf("  ids: %d", p.TotalIDs),
		fmt.Sprintf("  chunk size: %d", p.ChunkSize),
		fmt.Sprintf("  chunks: %d", p.Chunks),
	}
	if len(p.AddLabels) > 0 {
		lines = append(lines, "  add labels: "+strings.Join(p.AddLabels, ", "))
	}
	if len(p.RemoveLabels) > 0 {
		lines = append(lines, "  remove labels: "+strings.Join(p.RemoveLabels, ", "))
	}
	return strings.Join(append(lines, "  no API calls made"), "\n")
}

// formatBatchSummary is printBatchSummary.
func formatBatchSummary(r *batchResult) string {
	lines := []string{fmt.Sprintf("%s: %d/%d succeeded across %d chunk(s)", r.action, r.OK, r.TotalIDs, r.Chunks)}
	if len(r.Failed) > 0 {
		lines = append(lines, fmt.Sprintf("Failed chunks: %d", len(r.Failed)))
		for _, f := range r.Failed {
			rng := strings.Join(f.IDs, ", ")
			if len(f.IDs) > 4 {
				rng = fmt.Sprintf("%s..%s (%d ids)", f.IDs[0], f.IDs[len(f.IDs)-1], len(f.IDs))
			}
			lines = append(lines, fmt.Sprintf("  - %s: %s", rng, f.Reason))
		}
	}
	return strings.Join(lines, "\n")
}

// formatLabelList is printLabelList.
func formatLabelList(labels labelList) string {
	if len(labels) == 0 {
		return "No labels found"
	}
	nameWidth := 4
	for _, l := range labels {
		nameWidth = max(nameWidth, jsvalue.Length(google.Field(l, "name")))
	}
	lines := []string{jsvalue.PadEnd("NAME", nameWidth) + "  " + jsvalue.PadEnd("TYPE", 6) + "  ID"}
	for _, l := range labels {
		lines = append(lines, jsvalue.PadEnd(google.Field(l, "name"), nameWidth)+"  "+jsvalue.PadEnd(google.Field(l, "type"), 6)+"  "+google.Field(l, "id"))
	}
	return strings.Join(append(lines, "", fmt.Sprintf("%d label(s)", len(labels))), "\n")
}

// labelNamesReadable is printLabelList's `l.name.length` over every label:
// a label without a name throws before anything is printed.
func labelNamesReadable(labels []*jsvalue.Object) error {
	for _, l := range labels {
		if name := member(l, "name"); jsvalue.Nullish(name) {
			return jsvalue.TypeError(name, "l.name.length")
		}
	}
	return nil
}

// formatLabelModified is printLabelModified on a message.
func formatLabelModified(m *labelModified) string {
	var parts []string
	if len(m.Applied) > 0 {
		parts = append(parts, "applied ["+strings.Join(m.Applied, ", ")+"]")
	}
	if len(m.Removed) > 0 {
		parts = append(parts, "removed ["+strings.Join(m.Removed, ", ")+"]")
	}
	return "message " + m.ID + ": " + strings.Join(parts, "; ")
}

// labelNames is resolveLabelNames: each id's label name, else the id.
func labelNames(ids any, names map[string]any) ([]string, error) {
	if !google.Truthy(ids, "length") {
		return nil, nil
	}
	list, ok := ids.([]any)
	if !ok {
		return nil, notAFunction("ids.map", "ids.map((id) => labelNamesById.get(id) ?? id)")
	}
	var out []string
	for _, id := range list {
		name := id
		if s, ok := id.(string); ok {
			if n, ok := names[s]; ok && !jsvalue.Nullish(n) {
				name = n
			}
		}
		out = append(out, jsvalue.String(name))
	}
	return out, nil
}

// summarizeCriteria is summarizeFilterCriteria.
func summarizeCriteria(c any) string {
	var parts []string
	for _, f := range []struct{ key, prefix string }{
		{"from", "from:"}, {"to", "to:"}, {"subject", "subject:"}, {"query", "query:"}, {"negatedQuery", "-query:"},
	} {
		if google.Truthy(c, f.key) {
			parts = append(parts, f.prefix+google.Field(c, f.key))
		}
	}
	if google.Truthy(c, "hasAttachment") {
		parts = append(parts, "has:attachment")
	}
	if google.Truthy(c, "excludeChats") {
		parts = append(parts, "exclude:chats")
	}
	if isNumber(member(c, "size")) && google.Truthy(c, "sizeComparison") {
		parts = append(parts, "size:"+google.Field(c, "sizeComparison")+":"+google.Field(c, "size"))
	}
	if len(parts) == 0 {
		return "(no criteria)"
	}
	return strings.Join(parts, " ")
}

// summarizeAction is summarizeFilterAction.
func summarizeAction(a any, names map[string]any) (string, error) {
	var parts []string
	add, err := labelNames(member(a, "addLabelIds"), names)
	if err != nil {
		return "", err
	}
	for _, n := range add {
		parts = append(parts, "+"+n)
	}
	remove, err := labelNames(member(a, "removeLabelIds"), names)
	if err != nil {
		return "", err
	}
	for _, n := range remove {
		parts = append(parts, "-"+n)
	}
	if google.Truthy(a, "forward") {
		parts = append(parts, "forward:"+google.Field(a, "forward"))
	}
	if len(parts) == 0 {
		return "(no action)", nil
	}
	return strings.Join(parts, " "), nil
}

// filterIDsReadable is printFilterList's `f.id.length` over every filter:
// a filter without an id throws before anything is printed.
func filterIDsReadable(filters []*jsvalue.Object) error {
	for _, f := range filters {
		if id := member(f, "id"); jsvalue.Nullish(id) {
			return jsvalue.TypeError(id, "f.id.length")
		}
	}
	return nil
}

// The filter printers stop, as Bun's console.log lines do, at the first
// action they cannot read: the text is what was printed before the error.

// formatFilterList is printFilterList.
func formatFilterList(filters []*jsvalue.Object, names map[string]any) (string, error) {
	if len(filters) == 0 {
		return "No filters found", nil
	}
	idWidth := 2
	for _, f := range filters {
		idWidth = max(idWidth, jsvalue.Length(google.Field(f, "id")))
	}
	var lines []string
	for _, f := range filters {
		criteria := summarizeCriteria(member(f, "criteria"))
		action, err := summarizeAction(member(f, "action"), names)
		if err != nil {
			return strings.Join(lines, "\n"), err
		}
		lines = append(lines, jsvalue.PadEnd(google.Field(f, "id"), idWidth)+"  "+criteria+"  ->  "+action)
	}
	return strings.Join(append(lines, "", fmt.Sprintf("%d filter(s)", len(filters))), "\n"), nil
}

// formatFilterCreated is printFilterCreated.
func formatFilterCreated(f *jsvalue.Object, names map[string]any) (string, error) {
	head := "Created filter: " + google.Field(f, "id")
	criteria := summarizeCriteria(member(f, "criteria"))
	action, err := summarizeAction(member(f, "action"), names)
	if err != nil {
		return head, err
	}
	return head + "\n  " + criteria + "  ->  " + action, nil
}

// formatFilter is printFilter.
func formatFilter(f *jsvalue.Object, names map[string]any) (string, error) {
	lines := []string{"ID:       " + google.Field(f, "id")}
	c := member(f, "criteria")
	var criteria []string
	for _, row := range []struct{ key, label string }{
		{"from", "  From:           "}, {"to", "  To:             "}, {"subject", "  Subject:        "},
		{"query", "  Query:          "}, {"negatedQuery", "  Negated query:  "},
	} {
		if google.Truthy(c, row.key) {
			criteria = append(criteria, row.label+google.Field(c, row.key))
		}
	}
	if google.Truthy(c, "hasAttachment") {
		criteria = append(criteria, "  Has attachment: yes")
	}
	if google.Truthy(c, "excludeChats") {
		criteria = append(criteria, "  Exclude chats:  yes")
	}
	if isNumber(member(c, "size")) && google.Truthy(c, "sizeComparison") {
		criteria = append(criteria, "  Size:           "+google.Field(c, "sizeComparison")+" "+google.Field(c, "size")+" bytes")
	}
	if len(criteria) > 0 {
		lines = append(append(lines, "Criteria:"), criteria...)
	}
	a := member(f, "action")
	var action []string
	apply, err := labelNames(member(a, "addLabelIds"), names)
	if err != nil {
		return strings.Join(lines, "\n"), err
	}
	remove, err := labelNames(member(a, "removeLabelIds"), names)
	if err != nil {
		return strings.Join(lines, "\n"), err
	}
	if len(apply) > 0 {
		action = append(action, "  Apply labels:   "+strings.Join(apply, ", "))
	}
	if len(remove) > 0 {
		action = append(action, "  Remove labels:  "+strings.Join(remove, ", "))
	}
	if google.Truthy(a, "forward") {
		action = append(action, "  Forward:        "+google.Field(a, "forward"))
	}
	if len(action) > 0 {
		lines = append(append(lines, "Action:"), action...)
	}
	return strings.Join(lines, "\n"), nil
}

// printedBefore is what a printer wrote before it threw: the command's
// result beside the error, or nothing.
func printedBefore(text string, err error) (any, error) {
	if text == "" {
		return nil, err
	}
	return text, err
}

// formatDownloads is the attachment command's output: a count line when there
// are several, then printAttachmentDownloaded for each, a blank line between.
func formatDownloads(d *downloads) string {
	var lines []string
	if d.Count > 1 {
		lines = append(lines, fmt.Sprintf("Downloading %d attachment(s)...", d.Count), "")
	}
	for _, f := range d.Files {
		lines = append(lines, "Downloaded: "+f.Filename, "  Path: "+f.Path, "  Size: "+google.FormatBytes(f.Size))
		if d.Count > 1 {
			lines = append(lines, "")
		}
	}
	return strings.Join(lines, "\n")
}
