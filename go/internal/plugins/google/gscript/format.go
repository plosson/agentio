package gscript

import (
	"fmt"
	"strings"
)

// formatProject is printGScriptProject (create and metadata).
func formatProject(v any) string {
	p, _ := v.(*project)
	if p == nil {
		return ""
	}
	lines := []string{"Script ID: " + p.ScriptID, "Title: " + p.Title}
	for _, field := range []struct{ label, value string }{
		{"Bound to", p.ParentID},
		{"Created", p.CreateTime},
		{"Updated", p.UpdateTime},
		{"Creator", p.Creator},
		{"Last modified by", p.LastModifyUser},
	} {
		if field.value != "" {
			lines = append(lines, field.label+": "+field.value)
		}
	}
	lines = append(lines, "URL: "+p.URL)
	return strings.Join(lines, "\n")
}

// formatList is printGScriptList.
func formatList(v any) string {
	items, _ := v.([]listItem)
	if len(items) == 0 {
		return "No script projects found"
	}
	lines := []string{fmt.Sprintf("Script projects (%d)", len(items)), ""}
	for i, item := range items {
		bound := ""
		if item.ParentID != "" {
			bound = "  [bound to " + item.ParentID + "]"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s", i+1, item.Title, bound), "    ID: "+item.ScriptID)
		if item.ModifiedTime != "" {
			lines = append(lines, "    Modified: "+item.ModifiedTime)
		}
		lines = append(lines, "")
	}
	return strings.Join(lines, "\n")
}

// formatPull is printGScriptPullResult.
func formatPull(v any) string {
	r, _ := v.(*pulled)
	if r == nil {
		return ""
	}
	lines := []string{fmt.Sprintf("Pulled %d file(s) from %s into %s", len(r.Files), r.ScriptID, r.RootDir)}
	for _, f := range r.Files {
		lines = append(lines, "  "+f.LocalPath+" ("+f.Type+")")
	}
	return strings.Join(lines, "\n")
}

// formatPush is printGScriptPushResult (push and put).
func formatPush(v any) string {
	r, _ := v.(*pushed)
	if r == nil {
		return ""
	}
	lines := []string{fmt.Sprintf("Pushed %d file(s) to %s", len(r.Files), r.ScriptID)}
	for _, f := range r.Files {
		lines = append(lines, "  "+f.Name+" ("+f.Type+")")
	}
	return strings.Join(lines, "\n")
}

// formatSource is get's process.stdout.write(source): printed Verbatim.
func formatSource(v any) string {
	s, _ := v.(string)
	return s
}
