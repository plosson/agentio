// Package confluence is the Confluence service.
package confluence

import (
	"context"
	"fmt"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:         plugins.APIVersion,
		ID:                 "confluence",
		DisplayName:        "Confluence",
		Description:        "Use when interacting with Confluence via the agentio CLI.",
		CommandDescription: "Confluence operations",
		Profile: &plugins.ProfileSpec{
			AddDescription:     "Add a new Confluence profile with OAuth authentication",
			ProfileDescription: "Profile name (auto-detected from site URL if not provided)",
			Setup:              app.Setup,
			Validate:           validate,
			Reauthenticate:     app.Reauthenticate,
			ListInfo:           atlassian.ListInfo,
			Refresh:            atlassian.RefreshSpec(),
		},
		Commands: []plugins.CommandSpec{
			spacesCmd(), pagesCmd(), getCmd(), searchCmd(),
			createCmd(), updateCmd(), commentsCmd(), commentCmd(),
		},
	}
}

// app is Bun's Confluence OAuth flow on the shared Atlassian app.
var app = atlassian.App{
	ID:          "confluence",
	DisplayName: "Confluence",
	SitesName:   "Confluence",
	Scopes: []string{
		"read:page:confluence",
		"write:page:confluence",
		"read:space:confluence",
		"read:comment:confluence",
		"write:comment:confluence",
		"search:confluence",
		"read:me",
		"offline_access",
	},
	SetupInfo: "Test with: agentio confluence spaces",
}

// piped is Bun's `value || await readStdin()`: stdin is read only when the
// value is empty.
func piped(value string, in plugins.CommandInput) string {
	if value != "" {
		return value
	}
	return plugins.Stdin(in)
}

// createBody, bodyInput and commentBody are Bun's checks before
// getConfluenceClient; each returns the body the command sends.
func createBody(in plugins.CommandInput, fail plugins.FailFunc) (string, error) {
	if in.Option("space") == "" && in.Option("space-id") == "" {
		return "", fail("INVALID_PARAMS", "--space or --space-id is required", "")
	}
	return bodyInput(in, fail)
}

func bodyInput(in plugins.CommandInput, fail plugins.FailFunc) (string, error) {
	body := piped(in.Option("content"), in)
	if body == "" {
		return "", fail("INVALID_PARAMS", "Page body is required. Use --content or pipe via stdin.", "")
	}
	return body, nil
}

func commentBody(in plugins.CommandInput, fail plugins.FailFunc) (string, error) {
	text := piped(in.Arg("body"), in)
	if text == "" {
		return "", fail("INVALID_PARAMS", "Comment body is required. Provide as argument or pipe via stdin.", "")
	}
	return text, nil
}

// pageFormat is get's --format, checked before the client as in Bun.
func pageFormat(in plugins.CommandInput, fail plugins.FailFunc) (string, error) {
	format := in.Option("format")
	switch format {
	case "storage", "atlas_doc_format", "view":
		return format, nil
	}
	return "", fail("INVALID_PARAMS", fmt.Sprintf("Invalid format \"%s\". Use storage, atlas_doc_format, or view.", format), "")
}

func spacesCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "spaces",
		Description: "List Confluence spaces",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <number>", Description: "Maximum number of spaces", DefaultValue: "50"},
			{Flags: "--type <type>", Description: "Filter by type (global|personal|collaboration|knowledge_base)"},
		},
		Examples: []string{
			"# list all spaces",
			"agentio confluence spaces",
			"# only global spaces",
			"agentio confluence spaces --type global",
			"# with a limit",
			"agentio confluence spaces --limit 10",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).listSpaces(limitQuery(in, 50), in.Option("type")))
		},
		Format: formatSpaces,
	}
}

func pagesCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "pages",
		Description: "List Confluence pages",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--space <key>", Description: "Filter by space key"},
			{Flags: "--space-id <id>", Description: "Filter by space id"},
			{Flags: "--parent <id>", Description: "Filter by parent page id"},
			{Flags: "--limit <number>", Description: "Maximum number of pages", DefaultValue: "25"},
		},
		Examples: []string{
			"# pages in a space",
			"agentio confluence pages --space ENG",
			"# child pages of a parent",
			"agentio confluence pages --parent 123456",
			"# more results",
			"agentio confluence pages --space ENG --limit 50",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).listPages(in.Option("space"), in.Option("space-id"), in.Option("parent"), limitQuery(in, 25)))
		},
		Format: formatPages,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get a Confluence page (with body)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "page-id", Description: "Page ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--format <format>", Description: "Body format (storage|atlas_doc_format|view)", DefaultValue: "storage"},
		},
		Examples: []string{
			"# get a page (storage format)",
			"agentio confluence get 123456",
			"# get in view format (rendered HTML)",
			"agentio confluence get 123456 --format view",
			"# get as Atlas document format",
			"agentio confluence get 123456 --format atlas_doc_format",
		},
		Prepare: plugins.Parse(pageFormat),
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).getPage(in.Arg("page-id"), plugins.Prepared[string](run)))
		},
		Format: formatPage,
	}
}

func searchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "search",
		Description: "Search Confluence content using CQL",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--cql <query>", Description: "Raw CQL query"},
			{Flags: "--space <key>", Description: "Filter by space key"},
			{Flags: "--type <type>", Description: "Filter by type (page|blogpost|comment|attachment)"},
			{Flags: "--text <text>", Description: "Free-text search"},
			{Flags: "--limit <number>", Description: "Maximum number of results", DefaultValue: "25"},
		},
		Examples: []string{
			`# free-text search`,
			`agentio confluence search --text "deployment guide"`,
			`# raw CQL query`,
			`agentio confluence search --cql "space = ENG AND type = page AND title ~ 'API'"`,
			`# pages in a space matching text`,
			`agentio confluence search --space ENG --type page --text "onboarding"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).search(in.Option("cql"), in.Option("space"), in.Option("type"), in.Option("text"), limitQuery(in, 25)))
		},
		Format: formatSearch,
	}
}

func createCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "create",
		Description: "Create a Confluence page",
		Access:      "write",
		Prepare:     plugins.Parse(createBody),
		Operation:   "create page",
		Input:       "text",
		Options: []plugins.OptionSpec{
			{Flags: "--title <title>", Required: true, Description: "Page title"},
			{Flags: "--space <key>", Description: "Space key (or use --space-id)"},
			{Flags: "--space-id <id>", Description: "Space id (or use --space)"},
			{Flags: "--parent <id>", Description: "Parent page id"},
			{Flags: "--content <text>", Description: "Page body (or pipe via stdin)"},
		},
		Examples: []string{
			`# create a page in a space with inline content`,
			`agentio confluence create --title "My Page" --space ENG --content "<p>Hello world</p>"`,
			`# create with body piped from a file`,
			`cat page.html | agentio confluence create --title "My Page" --space ENG`,
			`# create as child of another page`,
			`agentio confluence create --title "Sub Page" --space ENG --parent 123456 --content "<p>Content</p>"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).createPage(in.Option("space"), in.Option("space-id"), in.Option("title"), in.OptionPtr("parent"), plugins.Prepared[string](run)))
		},
		Format: formatCreated,
	}
}

func updateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "update",
		Description: "Update a Confluence page (replaces body)",
		Access:      "write",
		Prepare:     plugins.Parse(bodyInput),
		Operation:   "update page",
		Input:       "text",
		Arguments:   []plugins.ArgumentSpec{{Name: "page-id", Description: "Page ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--title <title>", Description: "New page title (defaults to current title)"},
			{Flags: "--content <text>", Description: "Page body (or pipe via stdin)"},
		},
		Examples: []string{
			`# update page body inline`,
			`agentio confluence update 123456 --content "<p>Updated content</p>"`,
			`# update with body piped from a file`,
			`cat updated.html | agentio confluence update 123456`,
			`# update title and body`,
			`agentio confluence update 123456 --title "New Title" --content "<p>New content</p>"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).updatePage(in.Arg("page-id"), in.OptionPtr("title"), plugins.Prepared[string](run)))
		},
		Format: formatUpdated,
	}
}

func commentsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "comments",
		Description: "List footer comments on a page",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "page-id", Description: "Page ID", Required: true}},
		Examples: []string{
			"# list all footer comments on a page",
			"agentio confluence comments 123456",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).listComments(in.Arg("page-id")))
		},
		Format: formatComments,
	}
}

func commentCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "comment",
		Description: "Add a footer comment to a page",
		Access:      "write",
		Prepare:     plugins.Parse(commentBody),
		Operation:   "add comment",
		Input:       "text",
		Arguments: []plugins.ArgumentSpec{
			{Name: "page-id", Description: "Page ID", Required: true},
			{Name: "body", Description: "Comment body (or pipe via stdin)"},
		},
		Examples: []string{
			`# add an inline comment`,
			`agentio confluence comment 123456 "Looks good to me!"`,
			`# pipe comment body from stdin`,
			`echo "LGTM" | agentio confluence comment 123456`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(apiFrom(ctx, run).addComment(in.Arg("page-id"), plugins.Prepared[string](run)))
		},
		Format: formatComment,
	}
}
