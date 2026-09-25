package gdocs

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// formatCreated is printGDocCreated.
func formatCreated(c any) string {
	return strings.Join([]string{"Document created", "ID: " + google.Field(c, "id"), "Title: " + google.Field(c, "title"), "Link: " + google.Field(c, "webViewLink")}, "\n")
}

// formatTabs is printGDocsTabs.
func formatTabs(v any) string {
	tabs, _ := v.([]any)
	if len(tabs) == 0 {
		return "No tabs found (document has a single untitled tab)"
	}
	lines := []string{fmt.Sprintf("Tabs (%d)", len(tabs)), ""}
	for _, t := range tabs {
		depth, _ := jsvalue.Member(t, "depth").(int)
		lines = append(lines, strings.Repeat("  ", depth)+google.Field(t, "id")+"\t"+google.Field(t, "title"))
	}
	return strings.Join(lines, "\n")
}

// formatStructure is console.log(JSON.stringify(structure, null, 2)): an
// answer that is null, a string or a missing documentTab prints as Bun
// prints it ("null", a quoted string, "undefined").
func formatStructure(v any) string {
	if v == jsvalue.Undefined {
		return "undefined"
	}
	return string(jsvalue.StringifyIndent(v))
}
