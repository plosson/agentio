package jira

import (
	"fmt"
	"strings"
)

func trimFinal(s string) string {
	return strings.TrimSuffix(s, "\n")
}

func set(s *string) bool {
	return s != nil && *s != ""
}

func formatProjects(v any) string {
	projects, ok := v.([]project)
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
		if p.IsPrivate {
			private = " [private]"
		}
		fmt.Fprintf(&b, "%s - %s%s\n", p.Key, p.Name, private)
		fmt.Fprintf(&b, "    Type: %s\n", p.ProjectTypeKey)
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatIssues(v any) string {
	issues, ok := v.([]issue)
	if !ok {
		return ""
	}
	if len(issues) == 0 {
		return "No issues found"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Issues (%d)\n\n", len(issues))
	for _, i := range issues {
		fmt.Fprintf(&b, "%s [%s] %s\n", i.Key, i.Status, i.Summary)
		fmt.Fprintf(&b, "    Type: %s | Project: %s\n", i.IssueType, i.ProjectKey)
		if set(i.Assignee) {
			fmt.Fprintf(&b, "    Assignee: %s\n", *i.Assignee)
		}
		if set(i.Priority) {
			fmt.Fprintf(&b, "    Priority: %s\n", *i.Priority)
		}
		fmt.Fprintf(&b, "    Updated: %s\n", i.Updated)
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

func formatIssue(v any) string {
	i, ok := v.(issue)
	if !ok {
		return ""
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Key: %s\n", i.Key)
	fmt.Fprintf(&b, "Summary: %s\n", i.Summary)
	fmt.Fprintf(&b, "Status: %s\n", i.Status)
	fmt.Fprintf(&b, "Type: %s\n", i.IssueType)
	fmt.Fprintf(&b, "Project: %s\n", i.ProjectKey)
	if set(i.Priority) {
		fmt.Fprintf(&b, "Priority: %s\n", *i.Priority)
	}
	if set(i.Assignee) {
		fmt.Fprintf(&b, "Assignee: %s\n", *i.Assignee)
	}
	if set(i.Reporter) {
		fmt.Fprintf(&b, "Reporter: %s\n", *i.Reporter)
	}
	fmt.Fprintf(&b, "Created: %s\n", i.Created)
	fmt.Fprintf(&b, "Updated: %s\n", i.Updated)
	if i.Description != "" {
		b.WriteString("---\n")
		b.WriteString(i.Description)
		b.WriteString("\n")
	}
	return trimFinal(b.String())
}

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
		fmt.Fprintf(&b, "[%s] %s → %s\n", t.ID, t.Name, t.To.Name)
	}
	return trimFinal(b.String())
}

func formatComment(v any) string {
	r, ok := v.(commentResult)
	if !ok {
		return ""
	}
	return fmt.Sprintf("Comment added\nIssue: %s\nComment ID: %s", r.IssueKey, r.ID)
}

func formatTransition(v any) string {
	r, ok := v.(transitionResult)
	if !ok {
		return ""
	}
	return fmt.Sprintf("Issue transitioned\nIssue: %s\nTransition: %s\nNew Status: %s", r.IssueKey, r.TransitionName, r.NewStatus)
}
