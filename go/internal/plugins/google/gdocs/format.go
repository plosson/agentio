package gdocs

import (
	"fmt"
	"strings"
)

// formatList is printGDocsList.
func formatList(v any) string {
	docs, _ := v.([]document)
	if len(docs) == 0 {
		return "No documents found"
	}
	lines := []string{fmt.Sprintf("Documents (%d)", len(docs)), ""}
	for i, d := range docs {
		lines = append(lines, fmt.Sprintf("[%d] %s", i+1, d.Title), "    ID: "+d.ID)
		if d.Owner != "" {
			lines = append(lines, "    Owner: "+d.Owner)
		}
		if d.ModifiedTime != "" {
			lines = append(lines, "    Modified: "+d.ModifiedTime)
		}
		lines = append(lines, "    Link: "+d.WebViewLink, "")
	}
	return strings.Join(lines, "\n")
}

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
