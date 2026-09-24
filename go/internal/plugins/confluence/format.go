package confluence

import (
	"fmt"
	"strings"
	"unicode/utf16"
)

// truncate is JavaScript's `s.length > n ? s.slice(0, n) + '...' : s`, which
// counts UTF-16 code units, not runes.
func truncate(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) > n {
		return string(utf16.Decode(units[:n])) + "..."
	}
	return s
}

func trimFinal(s string) string {
	return strings.TrimSuffix(s, "\n")
}

func formatSpaces(v any) string {
	spaces, ok := v.([]space)
	if !ok {
		return ""
	}
	if len(spaces) == 0 {
		return "No spaces found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Spaces (%d)\n\n", len(spaces))
	for _, s := range spaces {
		fmt.Fprintf(&b, "%s - %s\n", s.Key, s.Name)
		fmt.Fprintf(&b, "    ID: %s\n", s.ID)
		fmt.Fprintf(&b, "    Type: %s | Status: %s\n", s.Type, s.Status)
		if s.Description != "" {
			fmt.Fprintf(&b, "    > %s\n", truncate(s.Description, 100))
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatPages(v any) string {
	pages, ok := v.([]page)
	if !ok {
		return ""
	}
	if len(pages) == 0 {
		return "No pages found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Pages (%d)\n\n", len(pages))
	for _, p := range pages {
		fmt.Fprintf(&b, "%s | %s\n", p.ID, p.Title)
		fmt.Fprintf(&b, "    Space: %s | Status: %s | v%d\n", p.SpaceID, p.Status, p.Version)
		if p.ParentID != "" {
			fmt.Fprintf(&b, "    Parent: %s\n", p.ParentID)
		}
		fmt.Fprintf(&b, "    Created: %s\n", p.CreatedAt)
		if p.WebURL != "" {
			fmt.Fprintf(&b, "    Link: %s\n", p.WebURL)
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatPage(v any) string {
	p, ok := v.(pageDetail)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "ID: %s\n", p.ID)
	fmt.Fprintf(&b, "Title: %s\n", p.Title)
	fmt.Fprintf(&b, "Space: %s\n", p.SpaceID)
	fmt.Fprintf(&b, "Status: %s\n", p.Status)
	fmt.Fprintf(&b, "Version: %d\n", p.Version)
	if p.ParentID != "" {
		fmt.Fprintf(&b, "Parent: %s\n", p.ParentID)
	}
	if p.AuthorID != "" {
		fmt.Fprintf(&b, "Author: %s\n", p.AuthorID)
	}
	fmt.Fprintf(&b, "Created: %s\n", p.CreatedAt)
	if p.WebURL != "" {
		fmt.Fprintf(&b, "Link: %s\n", p.WebURL)
	}
	if p.Body != "" {
		b.WriteString("---\n")
		b.WriteString(p.Body)
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatComments(v any) string {
	comments, ok := v.([]comment)
	if !ok {
		return ""
	}
	if len(comments) == 0 {
		return "No comments"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Comments (%d)\n\n", len(comments))
	for _, c := range comments {
		fmt.Fprintf(&b, "[%s] v%d %s\n", c.ID, c.Version, c.CreatedAt)
		if c.AuthorID != "" {
			fmt.Fprintf(&b, "    Author: %s\n", c.AuthorID)
		}
		fmt.Fprintf(&b, "    > %s\n", truncate(c.Body, 200))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatSearch(v any) string {
	results, ok := v.([]searchResult)
	if !ok {
		return ""
	}
	if len(results) == 0 {
		return "No results"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Results (%d)\n\n", len(results))
	for _, r := range results {
		fmt.Fprintf(&b, "[%s] %s | %s\n", r.Type, r.ID, r.Title)
		if r.SpaceKey != "" {
			fmt.Fprintf(&b, "    Space: %s\n", r.SpaceKey)
		}
		if r.LastModified != "" {
			fmt.Fprintf(&b, "    Modified: %s\n", r.LastModified)
		}
		if r.URL != "" {
			fmt.Fprintf(&b, "    Link: %s\n", r.URL)
		}
		if r.Excerpt != "" {
			fmt.Fprintf(&b, "    > %s\n", truncate(r.Excerpt, 150))
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatCreated(v any) string {
	r, ok := v.(pageCreated)
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("Page created\n")
	fmt.Fprintf(&b, "ID: %s\n", r.ID)
	fmt.Fprintf(&b, "Title: %s\n", r.Title)
	fmt.Fprintf(&b, "Space: %s\n", r.SpaceID)
	if r.WebURL != "" {
		fmt.Fprintf(&b, "Link: %s\n", r.WebURL)
	}
	return trimFinal(b.String())
}

func formatUpdated(v any) string {
	r, ok := v.(pageUpdated)
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("Page updated\n")
	fmt.Fprintf(&b, "ID: %s\n", r.ID)
	fmt.Fprintf(&b, "Title: %s\n", r.Title)
	fmt.Fprintf(&b, "Version: %d\n", r.Version)
	return trimFinal(b.String())
}

func formatComment(v any) string {
	r, ok := v.(commentCreated)
	if !ok {
		return ""
	}
	var b strings.Builder
	b.WriteString("Comment added\n")
	fmt.Fprintf(&b, "Page: %s\n", r.PageID)
	fmt.Fprintf(&b, "Comment ID: %s\n", r.ID)
	return trimFinal(b.String())
}
