package jira

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

func trimFinal(s string) string {
	return strings.TrimSuffix(s, "\n")
}

// str is `${o.key…}` for a model the client built.
func str(o any, keys ...string) string {
	return jsvalue.String(member(o, keys...))
}

func member(o any, keys ...string) any {
	for _, k := range keys {
		o = jsvalue.Member(o, k)
	}
	return o
}

func truthy(o any, key string) bool { return jsvalue.Truthy(jsvalue.Member(o, key)) }

// formatProjects is printJiraProjectList.
func formatProjects(v any) string {
	projects, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(projects) == 0 {
		return "No projects found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Projects (%d)\n\n", len(projects))
	for _, p := range projects {
		private := ""
		if truthy(p, "isPrivate") {
			private = " [private]"
		}
		fmt.Fprintf(&b, "%s - %s%s\n", str(p, "key"), str(p, "name"), private)
		fmt.Fprintf(&b, "    Type: %s\n", str(p, "projectTypeKey"))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatIssues is printJiraIssueList.
func formatIssues(v any) string {
	issues, ok := v.([]any)
	if !ok {
		return ""
	}
	if len(issues) == 0 {
		return "No issues found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Issues (%d)\n\n", len(issues))
	for _, i := range issues {
		fmt.Fprintf(&b, "%s [%s] %s\n", str(i, "key"), str(i, "status"), str(i, "summary"))
		fmt.Fprintf(&b, "    Type: %s | Project: %s\n", str(i, "issueType"), str(i, "projectKey"))
		if truthy(i, "assignee") {
			fmt.Fprintf(&b, "    Assignee: %s\n", str(i, "assignee"))
		}
		if truthy(i, "priority") {
			fmt.Fprintf(&b, "    Priority: %s\n", str(i, "priority"))
		}
		fmt.Fprintf(&b, "    Updated: %s\n", str(i, "updated"))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatIssue is printJiraIssue.
func formatIssue(v any) string {
	i, ok := v.(*jsvalue.Object)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Key: %s\n", str(i, "key"))
	fmt.Fprintf(&b, "Summary: %s\n", str(i, "summary"))
	fmt.Fprintf(&b, "Status: %s\n", str(i, "status"))
	fmt.Fprintf(&b, "Type: %s\n", str(i, "issueType"))
	fmt.Fprintf(&b, "Project: %s\n", str(i, "projectKey"))
	for _, f := range []struct{ key, label string }{{"priority", "Priority"}, {"assignee", "Assignee"}, {"reporter", "Reporter"}} {
		if truthy(i, f.key) {
			fmt.Fprintf(&b, "%s: %s\n", f.label, str(i, f.key))
		}
	}
	fmt.Fprintf(&b, "Created: %s\n", str(i, "created"))
	fmt.Fprintf(&b, "Updated: %s\n", str(i, "updated"))
	if truthy(i, "description") {
		b.WriteString("---\n")
		b.WriteString(str(i, "description"))
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

// formatTransitions is printJiraTransitions.
func formatTransitions(v any) string {
	l, ok := v.(transitionList)
	if !ok {
		return ""
	}
	if len(l.items) == 0 {
		return fmt.Sprintf("No transitions available for %s", l.issueKey)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Available transitions for %s:\n\n", l.issueKey)
	for _, t := range l.items {
		fmt.Fprintf(&b, "[%s] %s → %s\n", str(t, "id"), str(t, "name"), str(t, "to", "name"))
	}
	return trimFinal(b.String())
}

// formatComment is printJiraCommentResult.
func formatComment(v any) string {
	return fmt.Sprintf("Comment added\nIssue: %s\nComment ID: %s", str(v, "issueKey"), str(v, "id"))
}

// formatTransition is printJiraTransitionResult.
func formatTransition(v any) string {
	return fmt.Sprintf("Issue transitioned\nIssue: %s\nTransition: %s\nNew Status: %s",
		str(v, "issueKey"), str(v, "transitionName"), str(v, "newStatus"))
}
