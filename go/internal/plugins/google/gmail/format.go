package gmail

import (
	"encoding/json"
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
	labelList      []label
	labelCreated   label
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
	Old   string `json:"old"`
	Label label  `json:"label"`
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
	filters []filter
	names   map[string]string
}

func (f *filterListing) MarshalJSON() ([]byte, error) { return json.Marshal(f.filters) }

type filterView struct {
	filter filter
	names  map[string]string
}

func (f *filterView) MarshalJSON() ([]byte, error) { return json.Marshal(f.filter) }

type filterCreated struct {
	filter filter
	names  map[string]string
}

func (f *filterCreated) MarshalJSON() ([]byte, error) { return json.Marshal(f.filter) }

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
		return "Message sent\nID: " + r.ID + "\nThread: " + r.ThreadID
	case *draftResult:
		verb := "Draft created"
		if r.updated {
			verb = "Draft updated"
		}
		return verb + "\nDraft ID: " + r.ID + "\nMessage ID: " + r.MessageID
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
		return "Created label: " + r.Name + "\nID: " + r.ID
	case *labelDeleted:
		return fmt.Sprintf("Deleted label: %s (%s)", r.Name, r.ID)
	case *labelRenamed:
		return "Renamed label: " + r.Old + " -> " + r.Label.Name + "\nID: " + r.Label.ID
	case *labelModified:
		return formatLabelModified(r)
	case noMessages:
		return "label: 0 message(s) to modify"
	case *filterListing:
		return formatFilterList(r.filters, r.names)
	case *filterView:
		return formatFilter(r.filter, r.names)
	case *filterCreated:
		return "Created filter: " + r.filter.ID + "\n  " + summarizeCriteria(r.filter.Criteria) + "  ->  " + summarizeAction(r.filter.Action, r.names)
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

// formatMessageList is printMessageList.
func formatMessageList(l *messageList) string {
	lines := []string{fmt.Sprintf("Messages (%d of ~%d)", len(l.Messages), l.Total), ""}
	for i, m := range l.Messages {
		lines = append(lines, fmt.Sprintf("[%d] %s | thread:%s", i+1, m.ID, m.ThreadID))
		if m.From != "" {
			lines = append(lines, "    From: "+m.From)
		}
		if len(m.To) > 0 {
			lines = append(lines, "    To: "+strings.Join(m.To, ", "))
		}
		if m.Date != "" {
			lines = append(lines, "    Date: "+m.Date)
		}
		if m.Subject != "" {
			lines = append(lines, "    Subject: "+m.Subject)
		}
		if len(m.Labels) > 0 {
			lines = append(lines, "    Labels: "+strings.Join(m.Labels, ", "))
		}
		if m.Snippet != "" {
			lines = append(lines, "    > "+m.Snippet)
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

// formatMessage is printMessage.
func formatMessage(m *message) string {
	lines := []string{"ID: " + m.ID, "Thread: " + m.ThreadID, "From: " + m.From}
	if len(m.To) > 0 {
		lines = append(lines, "To: "+strings.Join(m.To, ", "))
	}
	if len(m.Cc) > 0 {
		lines = append(lines, "CC: "+strings.Join(m.Cc, ", "))
	}
	lines = append(lines, "Date: "+m.Date, "Subject: "+m.Subject)
	if len(m.Labels) > 0 {
		lines = append(lines, "Labels: "+strings.Join(m.Labels, ", "))
	}
	if m.Attachments != nil && len(*m.Attachments) > 0 {
		lines = append(lines, fmt.Sprintf("Attachments: %d", len(*m.Attachments)))
		for _, att := range *m.Attachments {
			lines = append(lines, fmt.Sprintf("  - %s (%s) [%s]", att.Filename, google.FormatBytes(att.Size), att.ID))
		}
	}
	body := ""
	if m.Body != nil {
		body = *m.Body
	}
	lines = append(lines, "---", body)
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
		nameWidth = max(nameWidth, jsvalue.Length(l.Name))
	}
	lines := []string{jsvalue.PadEnd("NAME", nameWidth) + "  " + jsvalue.PadEnd("TYPE", 6) + "  ID"}
	for _, l := range labels {
		lines = append(lines, jsvalue.PadEnd(l.Name, nameWidth)+"  "+jsvalue.PadEnd(l.Type, 6)+"  "+l.ID)
	}
	return strings.Join(append(lines, "", fmt.Sprintf("%d label(s)", len(labels))), "\n")
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

func labelNames(ids []string, names map[string]string) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[i] = id
		if name, ok := names[id]; ok {
			out[i] = name
		}
	}
	return out
}

// summarizeCriteria is summarizeFilterCriteria.
func summarizeCriteria(c filterCriteria) string {
	var parts []string
	add := func(cond bool, s string) {
		if cond {
			parts = append(parts, s)
		}
	}
	add(c.From != "", "from:"+c.From)
	add(c.To != "", "to:"+c.To)
	add(c.Subject != "", "subject:"+c.Subject)
	add(c.Query != "", "query:"+c.Query)
	add(c.NegatedQuery != "", "-query:"+c.NegatedQuery)
	add(c.HasAttachment, "has:attachment")
	add(c.ExcludeChats, "exclude:chats")
	if c.Size != nil && c.SizeComparison != "" {
		parts = append(parts, fmt.Sprintf("size:%s:%d", c.SizeComparison, *c.Size))
	}
	if len(parts) == 0 {
		return "(no criteria)"
	}
	return strings.Join(parts, " ")
}

// summarizeAction is summarizeFilterAction.
func summarizeAction(a filterAction, names map[string]string) string {
	var parts []string
	for _, n := range labelNames(a.AddLabelIDs, names) {
		parts = append(parts, "+"+n)
	}
	for _, n := range labelNames(a.RemoveLabelIDs, names) {
		parts = append(parts, "-"+n)
	}
	if a.Forward != "" {
		parts = append(parts, "forward:"+a.Forward)
	}
	if len(parts) == 0 {
		return "(no action)"
	}
	return strings.Join(parts, " ")
}

// formatFilterList is printFilterList.
func formatFilterList(filters []filter, names map[string]string) string {
	if len(filters) == 0 {
		return "No filters found"
	}
	idWidth := 2
	for _, f := range filters {
		idWidth = max(idWidth, jsvalue.Length(f.ID))
	}
	var lines []string
	for _, f := range filters {
		lines = append(lines, jsvalue.PadEnd(f.ID, idWidth)+"  "+summarizeCriteria(f.Criteria)+"  ->  "+summarizeAction(f.Action, names))
	}
	return strings.Join(append(lines, "", fmt.Sprintf("%d filter(s)", len(filters))), "\n")
}

// formatFilter is printFilter.
func formatFilter(f filter, names map[string]string) string {
	lines := []string{"ID:       " + f.ID}
	c := f.Criteria
	var criteria []string
	add := func(dst *[]string, cond bool, s string) {
		if cond {
			*dst = append(*dst, s)
		}
	}
	add(&criteria, c.From != "", "  From:           "+c.From)
	add(&criteria, c.To != "", "  To:             "+c.To)
	add(&criteria, c.Subject != "", "  Subject:        "+c.Subject)
	add(&criteria, c.Query != "", "  Query:          "+c.Query)
	add(&criteria, c.NegatedQuery != "", "  Negated query:  "+c.NegatedQuery)
	add(&criteria, c.HasAttachment, "  Has attachment: yes")
	add(&criteria, c.ExcludeChats, "  Exclude chats:  yes")
	if c.Size != nil && c.SizeComparison != "" {
		criteria = append(criteria, fmt.Sprintf("  Size:           %s %d bytes", c.SizeComparison, *c.Size))
	}
	if len(criteria) > 0 {
		lines = append(append(lines, "Criteria:"), criteria...)
	}
	var action []string
	apply, remove := labelNames(f.Action.AddLabelIDs, names), labelNames(f.Action.RemoveLabelIDs, names)
	add(&action, len(apply) > 0, "  Apply labels:   "+strings.Join(apply, ", "))
	add(&action, len(remove) > 0, "  Remove labels:  "+strings.Join(remove, ", "))
	add(&action, f.Action.Forward != "", "  Forward:        "+f.Action.Forward)
	if len(action) > 0 {
		lines = append(append(lines, "Action:"), action...)
	}
	return strings.Join(lines, "\n")
}

// formatDownloads is the attachment command's output: a count line when there
// are several, then printAttachmentDownloaded for each, a blank line between.
func formatDownloads(d *downloads) string {
	var lines []string
	if d.Count > 1 {
		lines = append(lines, fmt.Sprintf("Downloading %d attachment(s)...", d.Count), "")
	}
	for _, f := range d.Files {
		lines = append(lines, "Downloaded: "+f.Filename, "  Path: "+f.Path, "  Size: "+google.FormatBytes(int64(f.Size)))
		if d.Count > 1 {
			lines = append(lines, "")
		}
	}
	return strings.Join(lines, "\n")
}
