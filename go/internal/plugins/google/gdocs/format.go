package gdocs

import (
	"fmt"
	"strings"
)

// formatCreated is printGDocCreated.
func formatCreated(v any) string {
	c, _ := v.(*created)
	if c == nil {
		return ""
	}
	return strings.Join([]string{"Document created", "ID: " + c.ID, "Title: " + c.Title, "Link: " + c.WebViewLink}, "\n")
}

// formatTabs is printGDocsTabs.
func formatTabs(v any) string {
	tabs, _ := v.([]tab)
	if len(tabs) == 0 {
		return "No tabs found (document has a single untitled tab)"
	}
	lines := []string{fmt.Sprintf("Tabs (%d)", len(tabs)), ""}
	for _, t := range tabs {
		lines = append(lines, strings.Repeat("  ", t.Depth)+t.ID+"\t"+t.Title)
	}
	return strings.Join(lines, "\n")
}
