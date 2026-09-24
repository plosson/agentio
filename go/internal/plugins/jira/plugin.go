// Package jira is the JIRA service.
package jira

import (
	"context"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
)

// app is Bun's JIRA OAuth flow on the shared Atlassian app.
var app = atlassian.App{
	ID:          "jira",
	DisplayName: "JIRA",
	SitesName:   "Jira",
	Scopes: []string{
		"read:jira-work",
		"write:jira-work",
		"read:me",
		"offline_access",
	},
	SetupInfo: "Test with: agentio jira projects",
}

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "jira",
		DisplayName: "JIRA",
		Description: "Use when interacting with JIRA via the agentio CLI - search issues, comment, transition.",
		Profile: &plugins.ProfileSpec{
			Setup:          app.Setup,
			Validate:       validate,
			Reauthenticate: app.Reauthenticate,
			ListInfo:       atlassian.ListInfo,
			Refresh:        atlassian.RefreshSpec(),
		},
		Commands: []plugins.CommandSpec{
			projectsCmd(), searchCmd(), getCmd(), commentCmd(), transitionsCmd(), transitionCmd(),
		},
	}
}

var issueKeyArg = plugins.ArgumentSpec{Name: "issue-key", Description: "Issue key (e.g., PROJ-123)", Required: true}

func projectsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "projects",
		Description: "List JIRA projects",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <number>", Description: "Maximum number of projects", DefaultValue: "50"},
		},
		Examples: []string{
			"# all visible projects (default limit 50)",
			"agentio jira projects",
			"# cap the result count",
			"agentio jira projects --limit 10",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			projects, err := apiFrom(ctx, run).listProjects(in.Option("limit"))
			if err != nil {
				return nil, err
			}
			return projects, nil
		},
		Format: formatProjects,
	}
}

func searchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "search",
		Description: "Search JIRA issues",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--jql <query>", Description: "JQL query"},
			{Flags: "--project <key>", Description: "Project key"},
			{Flags: "--status <status>", Description: "Issue status"},
			{Flags: "--assignee <name>", Description: "Assignee name"},
			{Flags: "--limit <number>", Description: "Maximum number of issues", DefaultValue: "50"},
		},
		Examples: []string{
			"# everything assigned to you across all projects",
			`agentio jira search --jql "assignee = currentUser() AND resolution = Unresolved"`,
			"# bugs created in the last week in one project",
			`agentio jira search --jql "project = PROJ AND issuetype = Bug AND created >= -7d"`,
			"# convenience flags (combined with AND)",
			`agentio jira search --project PROJ --status "In Progress" --assignee alice`,
			"# high-priority items updated today, capped to 10",
			`agentio jira search --jql "priority = High AND updated >= -1d" --limit 10`,
			"",
			`JQL syntax: project = KEY, assignee = currentUser(), status = "In Progress",`,
			"created >= -7d, updated >= -1d, priority = High, labels = bug, resolution = Unresolved.",
			"Combine with AND / OR / NOT. Quote multi-word values.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			issues, err := apiFrom(ctx, run).searchIssues(
				in.Option("jql"), in.Option("project"), in.Option("status"), in.Option("assignee"), in.Option("limit"),
			)
			if err != nil {
				return nil, err
			}
			return issues, nil
		},
		Format: formatIssues,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get JIRA issue details",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{issueKeyArg},
		Examples: []string{
			"# full issue (summary, status, description, comments)",
			"agentio jira get PROJ-123",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			found, err := apiFrom(ctx, run).getIssue(in.Arg("issue-key"))
			if err != nil {
				return nil, err
			}
			return found, nil
		},
		Format: formatIssue,
	}
}

// commentBody is Bun's `body || await readStdin()`: readStdin decodes the
// piped bytes as UTF-8 and trims them.
func commentBody(in plugins.CommandInput) string {
	if body := in.Arg("body"); body != "" {
		return body
	}
	piped, _ := in.Stdin.(string)
	return jsvalue.Trim(jsvalue.BufferString([]byte(piped)))
}

func commentCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "comment",
		Description: "Add a comment to an issue",
		Input:       "text",
		// Bun checks the body before enforceWriteAccess, so a missing body is
		// the input error even on a read-only profile.
		AccessFor: func(in plugins.CommandInput) string {
			if commentBody(in) == "" {
				return "read"
			}
			return "write"
		},
		Operation: "add comment",
		Arguments: []plugins.ArgumentSpec{
			issueKeyArg,
			{Name: "body", Description: "Comment body (or pipe via stdin)"},
		},
		Examples: []string{
			"# short comment as an argument",
			`agentio jira comment PROJ-123 "Reproduced on staging."`,
			"# multi-line comment via stdin",
			"cat investigation.md | agentio jira comment PROJ-123",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			body := commentBody(in)
			if body == "" {
				return nil, run.Fail("INVALID_PARAMS", "Comment body is required. Provide as argument or pipe via stdin.", "")
			}
			added, err := apiFrom(ctx, run).addComment(in.Arg("issue-key"), body)
			if err != nil {
				return nil, err
			}
			return added, nil
		},
		Format: formatComment,
	}
}

func transitionsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "transitions",
		Description: "List available transitions for an issue",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{issueKeyArg},
		Examples: []string{
			"# see transition ids before calling 'jira transition'",
			"agentio jira transitions PROJ-123",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			list, err := apiFrom(ctx, run).getTransitions(in.Arg("issue-key"))
			if err != nil {
				return nil, err
			}
			return list, nil
		},
		Format: formatTransitions,
	}
}

func transitionCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "transition",
		Description: "Transition an issue to a new status",
		Access:      "write",
		Operation:   "transition issue",
		Arguments: []plugins.ArgumentSpec{
			issueKeyArg,
			{Name: "transition-id", Description: `Transition ID (use "transitions" command to see available)`, Required: true},
		},
		Examples: []string{
			"# move PROJ-123 to the status whose transition id is 31",
			"agentio jira transition PROJ-123 31",
			"# discover the id first, then run the transition",
			"agentio jira transitions PROJ-123",
			"agentio jira transition PROJ-123 41",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			done, err := apiFrom(ctx, run).transitionIssue(in.Arg("issue-key"), in.Arg("transition-id"))
			if err != nil {
				return nil, err
			}
			return done, nil
		},
		Format: formatTransition,
	}
}
