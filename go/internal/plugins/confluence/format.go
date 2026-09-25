package confluence

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

func trimFinal(s string) string {
	return strings.TrimSuffix(s, "\n")
}

// str is `${o.key}` for a model the client built.
func str(o any, key string) string { return jsvalue.String(jsvalue.Member(o, key)) }

func truthy(o any, key string) bool { return jsvalue.Truthy(jsvalue.Member(o, key)) }

// preview is `v.length > n ? v.slice(0, n) + '...' : v`.
func preview(v any, n int) string {
	if s, ok := v.(string); ok {
		return jsvalue.Truncate(s, n)
	}
	return jsvalue.String(v) // a value without a length is printed whole
}

// formatSpaces is printConfluenceSpaceList.
func formatSpaces(v any) string {
	spaces, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(spaces) == 0 {
		return "No spaces found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Spaces (%d)\n\n", len(spaces))
	for _, s := range spaces {
		fmt.Fprintf(&b, "%s - %s\n", str(s, "key"), str(s, "name"))
		fmt.Fprintf(&b, "    ID: %s\n", str(s, "id"))
		fmt.Fprintf(&b, "    Type: %s | Status: %s\n", str(s, "type"), str(s, "status"))
		if truthy(s, "description") {
			fmt.Fprintf(&b, "    > %s\n", preview(jsvalue.Member(s, "description"), 100))
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatPages is printConfluencePageList.
func formatPages(v any) string {
	pages, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(pages) == 0 {
		return "No pages found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Pages (%d)\n\n", len(pages))
	for _, p := range pages {
		fmt.Fprintf(&b, "%s | %s\n", str(p, "id"), str(p, "title"))
		fmt.Fprintf(&b, "    Space: %s | Status: %s | v%s\n", str(p, "spaceId"), str(p, "status"), str(p, "version"))
		if truthy(p, "parentId") {
			fmt.Fprintf(&b, "    Parent: %s\n", str(p, "parentId"))
		}
		fmt.Fprintf(&b, "    Created: %s\n", str(p, "createdAt"))
		if truthy(p, "webUrl") {
			fmt.Fprintf(&b, "    Link: %s\n", str(p, "webUrl"))
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatPage is printConfluencePage.
func formatPage(v any) string {
	p, ok := v.(*jsvalue.Object)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "ID: %s\n", str(p, "id"))
	fmt.Fprintf(&b, "Title: %s\n", str(p, "title"))
	fmt.Fprintf(&b, "Space: %s\n", str(p, "spaceId"))
	fmt.Fprintf(&b, "Status: %s\n", str(p, "status"))
	fmt.Fprintf(&b, "Version: %s\n", str(p, "version"))
	if truthy(p, "parentId") {
		fmt.Fprintf(&b, "Parent: %s\n", str(p, "parentId"))
	}
	if truthy(p, "authorId") {
		fmt.Fprintf(&b, "Author: %s\n", str(p, "authorId"))
	}
	fmt.Fprintf(&b, "Created: %s\n", str(p, "createdAt"))
	if truthy(p, "webUrl") {
		fmt.Fprintf(&b, "Link: %s\n", str(p, "webUrl"))
	}
	if truthy(p, "body") {
		b.WriteString("---\n")
		b.WriteString(str(p, "body"))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatComments is printConfluenceCommentList.
func formatComments(v any) string {
	comments, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(comments) == 0 {
		return "No comments"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Comments (%d)\n\n", len(comments))
	for _, c := range comments {
		fmt.Fprintf(&b, "[%s] v%s %s\n", str(c, "id"), str(c, "version"), str(c, "createdAt"))
		if truthy(c, "authorId") {
			fmt.Fprintf(&b, "    Author: %s\n", str(c, "authorId"))
		}
		fmt.Fprintf(&b, "    > %s\n", preview(jsvalue.Member(c, "body"), 200))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatSearch is printConfluenceSearchResults.
func formatSearch(v any) string {
	results, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(results) == 0 {
		return "No results"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Results (%d)\n\n", len(results))
	for _, r := range results {
		fmt.Fprintf(&b, "[%s] %s | %s\n", str(r, "type"), str(r, "id"), str(r, "title"))
		if truthy(r, "spaceKey") {
			fmt.Fprintf(&b, "    Space: %s\n", str(r, "spaceKey"))
		}
		if truthy(r, "lastModified") {
			fmt.Fprintf(&b, "    Modified: %s\n", str(r, "lastModified"))
		}
		if truthy(r, "url") {
			fmt.Fprintf(&b, "    Link: %s\n", str(r, "url"))
		}
		if truthy(r, "excerpt") {
			fmt.Fprintf(&b, "    > %s\n", preview(jsvalue.Member(r, "excerpt"), 150))
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatCreated is printConfluencePageCreated.
func formatCreated(v any) string {
	var b strings.Builder
	b.WriteString("Page created\n")
	fmt.Fprintf(&b, "ID: %s\n", str(v, "id"))
	fmt.Fprintf(&b, "Title: %s\n", str(v, "title"))
	fmt.Fprintf(&b, "Space: %s\n", str(v, "spaceId"))
	if truthy(v, "webUrl") {
		fmt.Fprintf(&b, "Link: %s\n", str(v, "webUrl"))
	}
	return trimFinal(b.String())
}

// formatUpdated is printConfluencePageUpdated.
func formatUpdated(v any) string {
	return fmt.Sprintf("Page updated\nID: %s\nTitle: %s\nVersion: %s", str(v, "id"), str(v, "title"), str(v, "version"))
}

// formatComment is printConfluenceCommentResult.
func formatComment(v any) string {
	return fmt.Sprintf("Comment added\nPage: %s\nComment ID: %s", str(v, "pageId"), str(v, "id"))
}
