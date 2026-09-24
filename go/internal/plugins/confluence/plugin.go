// Package confluence is the Confluence service.
package confluence

import (
	"context"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "confluence",
		DisplayName: "Confluence",
		Description: "Use when interacting with Confluence via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          setup,
			Validate:       validate,
			Reauthenticate: reauth,
			ListInfo:       listInfo,
			Refresh: &plugins.RefreshSpec{
				SecretFields: []string{"refreshToken"},
				Applies:      applies,
				IsStale:      stale,
				Run:          refresh,
			},
		},
		Commands: []plugins.CommandSpec{
			spacesCmd(), pagesCmd(), getCmd(), searchCmd(),
			createCmd(), updateCmd(), commentsCmd(), commentCmd(),
		},
	}
}

func listInfo(creds map[string]any) string {
	if site := str(creds, "siteUrl"); site != "" {
		return " - " + site
	}
	return ""
}

func opt(in plugins.CommandInput, name string) string {
	s, _ := in.Options[name].(string)
	return s
}

func arg(in plugins.CommandInput, name string) string {
	s, _ := in.Args[name].(string)
	return s
}

func piped(content string, stdin any) string {
	if content != "" {
		return content
	}
	text, _ := stdin.(string)
	return strings.TrimSpace(text)
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
			return apiFrom(ctx, run).listSpaces(limitQuery(opt(in, "limit"), 50), opt(in, "type"))
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
			return apiFrom(ctx, run).listPages(opt(in, "space"), opt(in, "space-id"), opt(in, "parent"), limitQuery(opt(in, "limit"), 25))
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
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			format := opt(in, "format")
			switch format {
			case "storage", "atlas_doc_format", "view":
			default:
				return nil, run.Fail("INVALID_PARAMS", fmt.Sprintf("Invalid format %q. Use storage, atlas_doc_format, or view.", format), "")
			}
			return apiFrom(ctx, run).getPage(arg(in, "page-id"), format)
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
			return apiFrom(ctx, run).search(opt(in, "cql"), opt(in, "space"), opt(in, "type"), opt(in, "text"), limitQuery(opt(in, "limit"), 25))
		},
		Format: formatSearch,
	}
}

func createCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "create",
		Description: "Create a Confluence page",
		Access:      "write",
		Operation:   "create page",
		Input:       "text",
		Options: []plugins.OptionSpec{
			{Flags: "--title <title>", Description: "Page title"},
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
			if opt(in, "title") == "" {
				return nil, run.Fail("INVALID_PARAMS", "required option '--title <title>' not specified", "")
			}
			if opt(in, "space") == "" && opt(in, "space-id") == "" {
				return nil, run.Fail("INVALID_PARAMS", "--space or --space-id is required", "")
			}
			body := piped(opt(in, "content"), in.Stdin)
			if body == "" {
				return nil, run.Fail("INVALID_PARAMS", "Page body is required. Use --content or pipe via stdin.", "")
			}
			return apiFrom(ctx, run).createPage(opt(in, "space"), opt(in, "space-id"), opt(in, "title"), opt(in, "parent"), body)
		},
		Format: formatCreated,
	}
}

func updateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "update",
		Description: "Update a Confluence page (replaces body)",
		Access:      "write",
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
			body := piped(opt(in, "content"), in.Stdin)
			if body == "" {
				return nil, run.Fail("INVALID_PARAMS", "Page body is required. Use --content or pipe via stdin.", "")
			}
			return apiFrom(ctx, run).updatePage(arg(in, "page-id"), opt(in, "title"), body)
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
			return apiFrom(ctx, run).listComments(arg(in, "page-id"))
		},
		Format: formatComments,
	}
}

func commentCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "comment",
		Description: "Add a footer comment to a page",
		Access:      "write",
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
			body := arg(in, "body")
			if body == "" {
				body = piped("", in.Stdin)
			}
			if body == "" {
				return nil, run.Fail("INVALID_PARAMS", "Comment body is required. Provide as argument or pipe via stdin.", "")
			}
			return apiFrom(ctx, run).addComment(arg(in, "page-id"), body)
		},
		Format: formatComment,
	}
}
