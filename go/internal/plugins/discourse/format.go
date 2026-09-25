package discourse

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

var htmlTag = regexp.MustCompile(`<[^>]*>`)

func trimFinal(s string) string {
	return strings.TrimSuffix(s, "\n")
}

// collapseSpace is `.replace(/\s+/g, ' ').trim()`.
func collapseSpace(s string) string {
	return strings.Join(strings.FieldsFunc(s, jsvalue.IsSpace), " ")
}

// field is `${o.key}`.
func field(o *jsvalue.Object, key string) string {
	return jsvalue.String(member(o, key))
}

func member(o *jsvalue.Object, key string) any {
	return jsvalue.Member(o, key)
}

func flagSuffix(o *jsvalue.Object) string {
	var flags []string
	for _, f := range []string{"pinned", "closed", "archived"} {
		if jsvalue.Truthy(member(o, f)) {
			flags = append(flags, f)
		}
	}
	if len(flags) == 0 {
		return ""
	}
	return " [" + strings.Join(flags, ", ") + "]"
}

// formatCategories is printDiscourseCategoryList.
func formatCategories(v any) string {
	cats, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(cats) == 0 {
		return "No categories found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Categories (%d)\n\n", len(cats))
	for _, c := range cats {
		cat := c.(*jsvalue.Object)
		parent := ""
		if jsvalue.Truthy(member(cat, "parentCategoryId")) {
			parent = " (subcategory)"
		}
		fmt.Fprintf(&b, "[%s] %s%s\n", field(cat, "id"), field(cat, "name"), parent)
		fmt.Fprintf(&b, "    Slug: %s\n", field(cat, "slug"))
		fmt.Fprintf(&b, "    Topics: %s | Posts: %s\n", field(cat, "topicCount"), field(cat, "postCount"))
		if description := member(cat, "description"); jsvalue.Truthy(description) {
			text := jsvalue.String(description)
			desc := jsvalue.Slice(htmlTag.ReplaceAllString(text, ""), 100)
			if desc != "" {
				more := ""
				if jsvalue.Length(text) > 100 {
					more = "..."
				}
				fmt.Fprintf(&b, "    > %s%s\n", desc, more)
			}
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatTopics is printDiscourseTopicList.
func formatTopics(v any) string {
	topics, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(topics) == 0 {
		return "No topics found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Topics (%d)\n\n", len(topics))
	for i, item := range topics {
		t := item.(*jsvalue.Object)
		fmt.Fprintf(&b, "[%d] %s | %s%s\n", i+1, field(t, "id"), field(t, "title"), flagSuffix(t))
		if jsvalue.Truthy(member(t, "categoryName")) {
			fmt.Fprintf(&b, "    Category: %s\n", field(t, "categoryName"))
		}
		fmt.Fprintf(&b, "    Posts: %s | Replies: %s | Views: %s | Likes: %s\n",
			field(t, "postsCount"), field(t, "replyCount"), field(t, "views"), field(t, "likeCount"))
		fmt.Fprintf(&b, "    Created: %s\n", field(t, "createdAt"))
		if !jsvalue.StrictEqual(member(t, "lastPostedAt"), member(t, "createdAt")) {
			fmt.Fprintf(&b, "    Last Post: %s\n", field(t, "lastPostedAt"))
		}
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatTopic is printDiscourseTopic. It stops, as Bun's console.log lines
// do, at the first post whose cooked text cannot be read (topicError).
func formatTopic(v any) string {
	t, ok := v.(*jsvalue.Object)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "ID: %s\n", field(t, "id"))
	fmt.Fprintf(&b, "Title: %s%s\n", field(t, "title"), flagSuffix(t))
	fmt.Fprintf(&b, "Slug: %s\n", field(t, "slug"))
	if jsvalue.Truthy(member(t, "categoryName")) {
		fmt.Fprintf(&b, "Category: %s\n", field(t, "categoryName"))
	}
	fmt.Fprintf(&b, "Posts: %s | Replies: %s | Views: %s | Likes: %s\n",
		field(t, "postsCount"), field(t, "replyCount"), field(t, "views"), field(t, "likeCount"))
	fmt.Fprintf(&b, "Created: %s\n", field(t, "createdAt"))
	fmt.Fprintf(&b, "Last Post: %s\n", field(t, "lastPostedAt"))
	b.WriteString("---\n")
	posts, _ := member(t, "posts").([]any)
	for _, item := range posts {
		p := item.(*jsvalue.Object)
		author := member(p, "displayName")
		if !jsvalue.Truthy(author) {
			author = member(p, "username")
		}
		fmt.Fprintf(&b, "\n[Post #%s] by %s (%s)\n", field(p, "postNumber"), jsvalue.String(author), field(p, "createdAt"))
		fmt.Fprintf(&b, "Likes: %s | Replies: %s\n", field(p, "likeCount"), field(p, "replyCount"))
		cooked := member(p, "cooked")
		if jsvalue.Nullish(cooked) {
			break
		}
		b.WriteString(collapseSpace(htmlTag.ReplaceAllString(jsvalue.String(cooked), " ")))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// topicError is the TypeError printDiscourseTopic throws after printing the
// post whose cooked text is null or undefined.
func topicError(t *jsvalue.Object) error {
	posts, _ := member(t, "posts").([]any)
	for _, item := range posts {
		if cooked := jsvalue.Member(item, "cooked"); jsvalue.Nullish(cooked) {
			return jsvalue.TypeError(cooked, "post.cooked.replace")
		}
	}
	return nil
}
