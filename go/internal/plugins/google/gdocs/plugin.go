// Package gdocs is the Google Docs service.
package gdocs

import (
	"context"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "gdocs",
		DisplayName: "Google Docs",
		Description: "Use when interacting with Google Docs via the agentio CLI - list, read, create.",
		Profile: &plugins.ProfileSpec{
			Setup:          google.Setup("gdocs", "Google Docs"),
			Validate:       google.ValidateDriveFiles(docMimeType),
			Reauthenticate: google.Reauthenticate("gdocs", google.Camel),
			Refresh:        google.Camel.RefreshSpec(),
			ListInfo:       google.EmailListInfo,
		},
		Commands: []plugins.CommandSpec{
			getCmd(), createCmd(), listCmd(), structureCmd(), tabsCmd(), batchCmd(),
		},
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Export a document",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "doc-id-or-url", Description: "Document ID or URL", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--format <format>", Description: "Export format: markdown or docx", DefaultValue: "markdown"},
			{Flags: "--output <file>", Description: "Output file path (required for docx, optional for markdown)"},
		},
		Examples: []string{
			"# print a document as markdown to stdout",
			"agentio gdocs get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"# accept a full Google Docs URL",
			"agentio gdocs get https://docs.google.com/document/d/1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit",
			"# save markdown to a file",
			"agentio gdocs get 1A2bCdEf... --output report.md",
			"# export to .docx (requires --output)",
			"agentio gdocs get 1A2bCdEf... --format docx --output report.docx",
		},
		// Bun prints the markdown (or "Exported to <file>") with console.log, so
		// the result is a string the host prints as is, an empty one included.
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			format, output := strings.ToLower(in.Option("format")), in.Option("output")
			if format != "markdown" && format != "docx" {
				return nil, run.Fail("INVALID_PARAMS", "Unknown format: "+format, "Use --format markdown or --format docx")
			}
			if format == "docx" && output == "" {
				return nil, run.Fail("INVALID_PARAMS", "Output file required for docx format", "Use --output <file.docx>")
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			mimeType, operation := "text/markdown", "export document as markdown"
			if format == "docx" {
				mimeType, operation = docxMimeType, "export document as docx"
			}
			content, err := a.ExportDriveFile(a.drive, extractDocID(in.Arg("doc-id-or-url")), mimeType, operation)
			if err != nil {
				return nil, err
			}
			if output == "" {
				return string(content), nil
			}
			if err := nodefs.WriteFile(output, content); err != nil {
				return nil, err
			}
			return "Exported to " + output, nil
		},
	}
}

// createContent is Bun's check before getGDocsClient: the content, which it
// returns.
func createContent(in plugins.CommandInput, fail plugins.FailFunc) (string, error) {
	content, _ := plugins.OptionOrStdin(in, "content", true)
	if content == "" {
		return "", fail("INVALID_PARAMS", "No content provided", "Provide --content or pipe markdown via stdin")
	}
	return content, nil
}

func createCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "create",
		Description: "Create a new document from Markdown",
		Access:      "write",
		Prepare:     plugins.Parse(createContent),
		Operation:   "create document",
		Input:       "text",
		Options: []plugins.OptionSpec{
			{Flags: "--title <title>", Required: true, Description: "Document title"},
			{Flags: "--content <text>", Description: "Markdown content (or pipe via stdin)"},
			{Flags: "--folder <folder-id>", Description: "Folder ID to create the document in"},
		},
		Examples: []string{
			"# create a doc with inline markdown content",
			`agentio gdocs create --title "Meeting Notes" --content "# Agenda\n- Topic 1\n- Topic 2"`,
			"# create a doc with body piped from a file",
			`cat draft.md | agentio gdocs create --title "Q4 Plan"`,
			"# create inside a specific Drive folder",
			`agentio gdocs create --title "Spec" --content "# Spec" --folder 1A2bCdEfGhIjKlMnOpQrStUvWxYz`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.create(in.Option("title"), plugins.Prepared[string](run), in.Option("folder")))
		},
		Format: formatCreated,
	}
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List recent documents",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Number of documents", DefaultValue: "10"},
			{Flags: "--query <query>", Description: "Drive search query filter"},
		},
		Examples: []string{
			"# 10 most recently modified docs",
			"agentio gdocs list",
			"# docs you own, more results",
			`agentio gdocs list --limit 50 --query "'me' in owners"`,
			"# search by name fragment",
			`agentio gdocs list --query "name contains 'report'"`,
			"# recently modified docs since a date",
			`agentio gdocs list --query "modifiedTime > '2024-01-01'"`,
			"",
			"Query syntax: name contains '...', name = '...', 'me' in owners,",
			"modifiedTime > 'YYYY-MM-DD', starred = true, trashed = false.",
			"Combine with 'and'/'or'.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.list(jsvalue.ParseInt(in.Option("limit")), in.Option("query")))
		},
		Format: func(v any) string { return google.FormatDriveFiles(v, "Documents", "No documents found") },
	}
}

// structureCmd has no Format: Bun prints JSON.stringify(structure, null, 2).
func structureCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "structure",
		Description: "Dump the full Docs API document representation as JSON",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "doc-id-or-url", Description: "Document ID or URL", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--tab <tab-id>", Description: "Return only this tab (indices are relative to the tab)"},
			{Flags: "--all-tabs", Description: "Include the content of every tab under .tabs[]"},
		},
		Examples: []string{
			"# dump full document structure (segment IDs, named styles, body indices, headers, footers)",
			"agentio gdocs structure 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"# extract the headerId after a createHeader batchUpdate",
			"agentio gdocs structure 1A2bCdEf... | jq '.headers | keys'",
			"# get body content with indices",
			"agentio gdocs structure 1A2bCdEf... | jq '.body.content'",
			"# body content of one tab (find the ID with: agentio gdocs tabs)",
			"agentio gdocs structure 1A2bCdEf... --tab t.4cykv13flp0m | jq '.body.content'",
			"# every tab's content in one payload",
			"agentio gdocs structure 1A2bCdEf... --all-tabs | jq '.tabs[].tabProperties'",
			"",
			"Without --tab or --all-tabs, only the first tab is returned (Docs API default).",
			"Indices from --tab are relative to that tab: pass the same tabId in the",
			"location/range of every batch request that writes to it.",
		},
		Prepare: plugins.Check(func(in plugins.CommandInput, fail plugins.FailFunc) error {
			if in.Option("tab") != "" && in.Flag("all-tabs") {
				return fail("INVALID_PARAMS", "--tab and --all-tabs are mutually exclusive", "")
			}
			return nil
		}),
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return a.structure(in.Arg("doc-id-or-url"), in.Option("tab"), in.Flag("all-tabs"))
		},
	}
}

func tabsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "tabs",
		Description: "List the tabs of a document (ID, title, nesting)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "doc-id-or-url", Description: "Document ID or URL", Required: true}},
		Examples: []string{
			"# list every tab with its ID",
			"agentio gdocs tabs 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"# a tab ID also appears in the browser URL as ?tab=t.xxxx",
			"agentio gdocs tabs https://docs.google.com/document/d/1A2bCdEf.../edit",
			"",
			"Tab IDs feed --tab on 'structure' and the location.tabId / range.tabId",
			"fields of 'batch' requests.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.listTabs(in.Arg("doc-id-or-url")))
		},
		Format: formatTabs,
	}
}

// batchCmd has no Format: Bun prints JSON.stringify({ documentId, replies }, null, 2)
// after the summary on stderr.
func batchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "batch",
		Description: "Execute raw documents.batchUpdate requests (escape hatch)",
		Access:      "write",
		Prepare:     plugins.Parse(google.BatchRequests),
		Operation:   "execute batch update",
		Arguments:   []plugins.ArgumentSpec{{Name: "doc-id-or-url", Description: "Document ID or URL", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--requests-json <json>", Description: "Inline JSON array of batchUpdate requests"},
			{Flags: "--file <path>", Description: "Path to a JSON file containing the requests array"},
		},
		Examples: []string{
			"# apply bold to a range of text (start/end offsets from the document body)",
			`agentio gdocs batch 1A2bCdEf... --requests-json '[{"updateTextStyle":{"range":{"startIndex":1,"endIndex":10},"textStyle":{"bold":true},"fields":"bold"}}]'`,
			"# load requests from a file",
			"agentio gdocs batch 1A2bCdEf... --file ./requests.json",
			"# write into a specific tab (indices come from: agentio gdocs structure --tab)",
			`agentio gdocs batch 1A2bCdEf... --requests-json '[{"insertText":{"location":{"index":1,"tabId":"t.4cykv13flp0m"},"text":"Hello"}}]'`,
			"",
			"In a multi-tab document every location/range must carry the tabId, otherwise",
			"the request lands in the first tab.",
			"",
			"Accepts an array of Docs API Request objects. See:",
			"https://developers.google.com/docs/api/reference/rest/v1/documents/request",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			result, err := a.batch(in.Arg("doc-id-or-url"), plugins.Prepared[[]any](run))
			if err != nil {
				return nil, err
			}
			run.Log(fmt.Sprintf("Batch update applied to %s (%d replies)", result.DocumentID, replyCount(result.Replies)))
			return result, nil
		},
	}
}

// replyCount is `result.replies.length`.
func replyCount(replies any) int {
	items, _ := replies.([]any)
	return len(items)
}
