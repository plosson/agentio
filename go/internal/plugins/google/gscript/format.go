package gscript

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins/google"
)

// formatProject is printGScriptProject (create and metadata), over the Bun
// object toProject builds: a missing scriptId prints "undefined".
func formatProject(p any) string {
	lines := []string{"Script ID: " + google.Field(p, "scriptId"), "Title: " + google.Field(p, "title")}
	for _, f := range []struct{ label, key string }{
		{"Bound to", "parentId"},
		{"Created", "createTime"},
		{"Updated", "updateTime"},
		{"Creator", "creator"},
		{"Last modified by", "lastModifyUser"},
	} {
		if google.Truthy(p, f.key) {
			lines = append(lines, f.label+": "+google.Field(p, f.key))
		}
	}
	lines = append(lines, "URL: "+google.Field(p, "url"))
	return strings.Join(lines, "\n")
}

// formatList is printGScriptList.
func formatList(v any) string {
	items, _ := v.([]any)
	if len(items) == 0 {
		return "No script projects found"
	}
	lines := []string{fmt.Sprintf("Script projects (%d)", len(items)), ""}
	for i, item := range items {
		bound := ""
		if google.Truthy(item, "parentId") {
			bound = "  [bound to " + google.Field(item, "parentId") + "]"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s", i+1, google.Field(item, "title"), bound), "    ID: "+google.Field(item, "scriptId"))
		if google.Truthy(item, "modifiedTime") {
			lines = append(lines, "    Modified: "+google.Field(item, "modifiedTime"))
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
