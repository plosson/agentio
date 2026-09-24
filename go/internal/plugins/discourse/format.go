package discourse

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"
)

var htmlTag = regexp.MustCompile(`<[^>]*>`)

func trimFinal(s string) string {
	return strings.TrimSuffix(s, "\n")
}

// jsSpace is the set JavaScript's \s and String.prototype.trim match.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// collapseSpace is `.replace(/\s+/g, ' ').trim()`.
func collapseSpace(s string) string {
	return strings.Join(strings.FieldsFunc(s, jsSpace), " ")
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// substring100 is `s.substring(0, 100)`, counted in UTF-16 units.
func substring100(s string) string {
	units := utf16.Encode([]rune(s))
	if len(units) > 100 {
		return string(utf16.Decode(units[:100]))
	}
	return s
}

func flagSuffix(pinned, closed, archived bool) string {
	var flags []string
	if pinned {
		flags = append(flags, "pinned")
	}
	if closed {
		flags = append(flags, "closed")
	}
	if archived {
		flags = append(flags, "archived")
	}
	if len(flags) == 0 {
		return ""
	}
	return " [" + strings.Join(flags, ", ") + "]"
}

func formatCategories(v any) string {
	cats, ok := v.([]category)
	if !ok {
		return ""
	}
	if len(cats) == 0 {
		return "No categories found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Categories (%d)\n\n", len(cats))
	for _, c := range cats {
		parent := ""
		if c.ParentCategoryID != nil && *c.ParentCategoryID != 0 {
			parent = " (subcategory)"
		}
		fmt.Fprintf(&b, "[%d] %s%s\n", c.ID, c.Name, parent)
		fmt.Fprintf(&b, "    Slug: %s\n", c.Slug)
		fmt.Fprintf(&b, "    Topics: %d | Posts: %d\n", c.TopicCount, c.PostCount)
		if c.Description != "" {
			desc := substring100(htmlTag.ReplaceAllString(c.Description, ""))
			if desc != "" {
				more := ""
				if utf16Len(c.Description) > 100 {
					more = "..."
				}
				fmt.Fprintf(&b, "    > %s%s\n", desc, more)
			}
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatTopics(v any) string {
	topics, ok := v.([]topic)
	if !ok {
		return ""
	}
	if len(topics) == 0 {
		return "No topics found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Topics (%d)\n\n", len(topics))
	for i, t := range topics {
		fmt.Fprintf(&b, "[%d] %d | %s%s\n", i+1, t.ID, t.Title, flagSuffix(t.Pinned, t.Closed, t.Archived))
		if t.CategoryName != nil && *t.CategoryName != "" {
			fmt.Fprintf(&b, "    Category: %s\n", *t.CategoryName)
		}
		fmt.Fprintf(&b, "    Posts: %d | Replies: %d | Views: %d | Likes: %d\n", t.PostsCount, t.ReplyCount, t.Views, t.LikeCount)
		fmt.Fprintf(&b, "    Created: %s\n", t.CreatedAt)
		if t.LastPostedAt != t.CreatedAt {
			fmt.Fprintf(&b, "    Last Post: %s\n", t.LastPostedAt)
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatTopic(v any) string {
	t, ok := v.(topicDetail)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "ID: %d\n", t.ID)
	fmt.Fprintf(&b, "Title: %s%s\n", t.Title, flagSuffix(t.Pinned, t.Closed, t.Archived))
	fmt.Fprintf(&b, "Slug: %s\n", t.Slug)
	if t.CategoryName != nil && *t.CategoryName != "" {
		fmt.Fprintf(&b, "Category: %s\n", *t.CategoryName)
	}
	fmt.Fprintf(&b, "Posts: %d | Replies: %d | Views: %d | Likes: %d\n", t.PostsCount, t.ReplyCount, t.Views, t.LikeCount)
	fmt.Fprintf(&b, "Created: %s\n", t.CreatedAt)
	fmt.Fprintf(&b, "Last Post: %s\n", t.LastPostedAt)
	b.WriteString("---\n")
	for _, p := range t.Posts {
		author := p.Username
		if p.DisplayName != nil && *p.DisplayName != "" {
			author = *p.DisplayName
		}
		fmt.Fprintf(&b, "\n[Post #%d] by %s (%s)\n", p.PostNumber, author, p.CreatedAt)
		fmt.Fprintf(&b, "Likes: %d | Replies: %d\n", p.LikeCount, p.ReplyCount)
		b.WriteString(collapseSpace(htmlTag.ReplaceAllString(p.Cooked, " ")))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}
