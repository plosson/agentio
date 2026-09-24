// Package gslides is the Google Slides service.
package gslides

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
		ID:          "gslides",
		DisplayName: "Google Slides",
		Description: "Use when interacting with Google Slides via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          google.Setup("gslides", "Google Slides"),
			Validate:       google.ValidateDriveFiles(presentationMimeType),
			Reauthenticate: google.Reauthenticate("gslides", google.Camel),
			Refresh:        google.Camel.RefreshSpec(),
			ListInfo:       google.EmailListInfo,
		},
		Commands: []plugins.CommandSpec{
			listCmd(), metadataCmd(), getCmd(), exportCmd(), createCmd(), copyCmd(), batchCmd(),
		},
	}
}

var presentationArg = plugins.ArgumentSpec{Name: "id-or-url", Description: "Presentation ID or URL", Required: true}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List recent presentations",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Number of presentations", DefaultValue: "10"},
			{Flags: "--query <query>", Description: "Drive search query filter"},
		},
		Examples: []string{
			"# 10 most recently modified presentations",
			"agentio gslides list",
			"# presentations you own",
			`agentio gslides list --query "'me' in owners" --limit 50`,
			"# search by name fragment",
			`agentio gslides list --query "name contains 'Q4'"`,
			"# recently modified",
			`agentio gslides list --query "modifiedTime > '2024-01-01'"`,
			"",
			"Query syntax: name contains '...', name = '...', 'me' in owners,",
			"modifiedTime > 'YYYY-MM-DD'. Combine with 'and'/'or'.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.list(jsvalue.ParseInt(in.Option("limit")), in.Option("query")))
		},
		Format: func(v any) string { return google.FormatDriveFiles(v, "Presentations", "No presentations found") },
	}
}

func metadataCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "metadata",
		Description: "Get presentation structure (slide count, dimensions, slide titles)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{presentationArg},
		Examples: []string{
			"# slide count, dimensions, slide titles",
			"agentio gslides metadata 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"# accept a full URL",
			"agentio gslides metadata https://docs.google.com/presentation/d/1A2bCdEf.../edit",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.metadata(in.Arg("id-or-url")))
		},
		Format: formatMetadata,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Read slide content as text (all slides or one by index)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{presentationArg},
		Options: []plugins.OptionSpec{
			{Flags: "--slide <n>", Description: "Zero-based slide index to read (omit for all slides)"},
		},
		Examples: []string{
			"# read all slides as text",
			"agentio gslides get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"# read only slide 0 (first slide)",
			"agentio gslides get 1A2bCdEf... --slide 0",
			"# accept a full URL",
			"agentio gslides get https://docs.google.com/presentation/d/1A2bCdEf.../edit",
			"",
			"Output includes text elements and speaker notes for each slide.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			// Commander's parseInt argParser: absent is undefined.
			var slide *float64
			if s := in.Option("slide"); s != "" {
				n := jsvalue.ParseInt(s)
				slide = &n
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.get(in.Arg("id-or-url"), slide))
		},
		Format: formatContent,
	}
}

// exportCmd has no Format: Bun prints three lines with console.log after
// writing the file, so the result is that text.
func exportCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "export",
		Description: "Export a presentation to a file",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{presentationArg},
		Options: []plugins.OptionSpec{
			{Flags: "--output <path>", Description: "Output file path"},
			{Flags: "--format <fmt>", Description: "Export format: pptx, pdf, or odp", DefaultValue: "pptx"},
		},
		Examples: []string{
			"# default pptx export",
			"agentio gslides export 1A2bCdEf... --output deck.pptx",
			"# PDF",
			"agentio gslides export 1A2bCdEf... --output deck.pdf --format pdf",
			"# ODP (LibreOffice)",
			"agentio gslides export 1A2bCdEf... --output deck.odp --format odp",
			"",
			"Formats: pptx (default), pdf, odp.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := plugins.RequireOptions(in, run.Fail, "--output <path>"); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			format := strings.ToLower(in.Option("format"))
			mimeType, ok := exportMimeTypes[format]
			if !ok {
				return nil, run.Fail("INVALID_PARAMS", "Unknown format: "+format, "Use pptx, pdf, or odp")
			}
			data, err := a.ExportDriveFile(a.drive, extractPresentationID(in.Arg("id-or-url")), mimeType, "export presentation")
			if err != nil {
				return nil, err
			}
			output := in.Option("output")
			if err := nodefs.WriteFile(output, data); err != nil {
				return nil, err
			}
			return fmt.Sprintf("Exported to %s\n  Format: %s\n  Size: %d bytes", output, format, len(data)), nil
		},
	}
}

func createCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "create",
		Description: "Create a new blank presentation",
		Access:      "write",
		Operation:   "create presentation",
		Arguments:   []plugins.ArgumentSpec{{Name: "title", Description: "Presentation title", Required: true}},
		Examples: []string{
			"# create a blank presentation",
			`agentio gslides create "Q4 Review"`,
			"# with a specific profile",
			`agentio gslides create "Team Deck" --profile work@example.com`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.create(in.Arg("title")))
		},
		Format: formatCreated,
	}
}

func copyCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "copy",
		Description: "Copy a presentation",
		Access:      "write",
		Operation:   "copy presentation",
		Arguments:   []plugins.ArgumentSpec{presentationArg, {Name: "title", Description: "New presentation title", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--parent <folder-id>", Description: "Destination folder ID"},
		},
		Examples: []string{
			"# duplicate to My Drive root",
			`agentio gslides copy 1A2bCdEf... "Q4 Review (copy)"`,
			"# duplicate into a specific folder",
			`agentio gslides copy 1A2bCdEf... "Q4 Review (copy)" --parent 1FoLdErIdAbCd...`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.CopyDriveFile(a.drive, extractPresentationID(in.Arg("id-or-url")), in.Arg("title"), in.Option("parent"), "copy presentation", presentationURL))
		},
		Format: formatCreated,
	}
}

func batchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "batch",
		Description: "Execute raw presentations.batchUpdate requests (escape hatch)",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(google.BatchInputError),
		Operation:   "execute batch update",
		Arguments:   []plugins.ArgumentSpec{presentationArg},
		Options: []plugins.OptionSpec{
			{Flags: "--requests-json <json>", Description: "Inline JSON array of Request objects"},
			{Flags: "--file <path>", Description: "Path to a JSON file containing the requests array"},
		},
		Examples: []string{
			"# insert a new blank slide at the end (inline JSON)",
			`agentio gslides batch 1A2bCdEf... --requests-json '[{"createSlide":{"insertionIndex":999,"slideLayoutReference":{"predefinedLayout":"BLANK"}}}]'`,
			"# from a file",
			"agentio gslides batch 1A2bCdEf... --file ./requests.json",
			"",
			"Accepts an array of Slides API Request objects. See:",
			"https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			requests, err := google.BatchRequests(in, run.Fail)
			if err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.batch(in.Arg("id-or-url"), requests))
		},
		Format: formatBatch,
	}
}
