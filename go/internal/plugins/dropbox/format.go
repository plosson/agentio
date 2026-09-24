package dropbox

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// formatBytes is Bun's formatBytes: parseFloat(x.toFixed(1)) with the unit.
// Past GB the unit is missing from the table, which JavaScript prints as "undefined".
func formatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	sizes := []string{"B", "KB", "MB", "GB"}
	i := int(math.Floor(math.Log(float64(bytes)) / math.Log(1024)))
	value := float64(bytes) / math.Pow(1024, float64(i))
	// toFixed rounds a tie up; strconv would round it to even.
	rounded := math.Round(value*10) / 10
	unit := "undefined"
	if i >= 0 && i < len(sizes) {
		unit = sizes[i]
	}
	return strconv.FormatFloat(rounded, 'f', -1, 64) + " " + unit
}

func trimFinal(s string) string {
	return strings.TrimSuffix(s, "\n")
}

func formatEntryList(v any) string {
	list, ok := v.(entryList)
	if !ok {
		return ""
	}
	if len(list.entries) == 0 {
		return "No entries found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s (%d)\n\n", list.title, len(list.entries))
	for _, e := range list.entries {
		size := "        -"
		if e.Size != nil {
			size = fmt.Sprintf("%9s", formatBytes(*e.Size))
		}
		date := "          "
		if e.Modified != nil && *e.Modified != "" {
			date = *e.Modified
			if len(date) > 10 {
				date = date[:10]
			}
		}
		path := e.Path
		if e.Type == "folder" {
			path += "/"
		}
		fmt.Fprintf(&b, "%-6s %s  %s  %s\n", e.Type, size, date, path)
	}
	return trimFinal(b.String())
}

func formatEntry(v any) string {
	e, ok := v.(entry)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Path: %s\n", e.Path)
	fmt.Fprintf(&b, "Name: %s\n", e.Name)
	fmt.Fprintf(&b, "Type: %s\n", e.Type)
	if e.ID != "" {
		fmt.Fprintf(&b, "ID: %s\n", e.ID)
	}
	if e.Size != nil {
		fmt.Fprintf(&b, "Size: %s\n", formatBytes(*e.Size))
	}
	if e.Modified != nil && *e.Modified != "" {
		fmt.Fprintf(&b, "Modified: %s\n", *e.Modified)
	}
	if e.Rev != nil && *e.Rev != "" {
		fmt.Fprintf(&b, "Rev: %s\n", *e.Rev)
	}
	if e.ContentHash != nil && *e.ContentHash != "" {
		fmt.Fprintf(&b, "Content hash: %s\n", *e.ContentHash)
	}
	return trimFinal(b.String())
}

// entryLine is the one-line confirmation mkdir, move, copy and delete print.
func entryLine(prefix string) func(any) string {
	return func(v any) string {
		e, ok := v.(entry)
		if !ok {
			return ""
		}
		return prefix + e.Path
	}
}

func formatDownloaded(v any) string {
	r, ok := v.(downloadResult)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Downloaded: %s\n", r.Path)
	fmt.Fprintf(&b, "  Path: %s\n", r.OutputPath)
	fmt.Fprintf(&b, "  Size: %s\n", formatBytes(r.Size))
	if r.Kind == "folder" {
		b.WriteString("  Format: zip archive\n")
	}
	return trimFinal(b.String())
}

func formatUploaded(v any) string {
	r, ok := v.(uploadResult)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Uploaded: %s\n", r.Path)
	fmt.Fprintf(&b, "  Size: %s\n", formatBytes(r.Size))
	if r.ID != "" {
		fmt.Fprintf(&b, "  ID: %s\n", r.ID)
	}
	if r.Rev != nil && *r.Rev != "" {
		fmt.Fprintf(&b, "  Rev: %s\n", *r.Rev)
	}
	return trimFinal(b.String())
}

func formatLink(v any) string {
	l, ok := v.(link)
	if !ok {
		return ""
	}
	expires := "  Expires: never"
	if l.Kind == "temporary" {
		expires = "  Expires: in 4 hours"
	}
	return fmt.Sprintf("%s\n  Path: %s\n%s", l.URL, l.Path, expires)
}

func formatAccount(v any) string {
	a, ok := v.(account)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Account: %s\n", a.Name)
	verified := ""
	if !a.EmailVerified {
		verified = " (unverified)"
	}
	fmt.Fprintf(&b, "  Email: %s%s\n", a.Email, verified)
	fmt.Fprintf(&b, "  Type: %s\n", a.AccountType)
	if a.Country != nil && *a.Country != "" {
		fmt.Fprintf(&b, "  Country: %s\n", *a.Country)
	}
	fmt.Fprintf(&b, "  ID: %s\n", a.AccountID)
	return trimFinal(b.String())
}
