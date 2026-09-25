// Package gscript is the Google Apps Script service.
package gscript

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
		ID:          "gscript",
		DisplayName: "Google Apps Script",
		Description: "Use when interacting with Google Apps Script via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          google.Setup("gscript", "Google Apps Script"),
			Validate:       google.ValidateDriveFiles(scriptMimeType),
			Reauthenticate: google.Reauthenticate("gscript", google.Camel),
			Refresh:        google.Camel.RefreshSpec(),
			ListInfo:       google.EmailListInfo,
		},
		Commands: []plugins.CommandSpec{
			createCmd(), metadataCmd(), listCmd(), deleteCmd(), pullCmd(), pushCmd(), getCmd(), putCmd(),
		},
	}
}

var idArg = plugins.ArgumentSpec{Name: "id", Description: "Script project ID", Required: true}

func createCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "create",
		Description: "Create a new Apps Script project (standalone or container-bound)",
		Access:      "write",
		Prepare:     plugins.Required("--title <title>"),
		Operation:   "create script project",
		Options: []plugins.OptionSpec{
			{Flags: "--title <title>", Description: "Script project title"},
			{Flags: "--parent <containerId>", Description: "Bind to a Sheet/Doc/Form/Slides ID (omit for standalone)"},
		},
		Examples: []string{
			"# standalone script",
			`agentio gscript create --title "Helper Library"`,
			"# bound to a Sheet",
			`agentio gscript create --title "Sheet automation" --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789`,
			"# bound to a Doc, with explicit profile",
			`agentio gscript create --title "Doc tools" --parent 1Doc... --profile work@example.com`,
			"",
			"The --parent ID is the container's Drive file ID (Sheet/Doc/Form/Slides).",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.create(in.Option("title"), in.OptionPtr("parent")))
		},
		Format: formatProject,
	}
}

func metadataCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "metadata",
		Description: "Get script project metadata",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{idArg},
		Examples: []string{
			"# show title, owner, timestamps, parent, editor URL",
			"agentio gscript metadata 1abc...XYZ",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.metadata(in.Arg("id")))
		},
		Format: formatProject,
	}
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List script projects (optionally filtered to a container)",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--parent <containerId>", Description: "Only list scripts bound to this container"},
			{Flags: "--limit <n>", Description: "Max results", DefaultValue: "25"},
		},
		Examples: []string{
			"# all script projects",
			"agentio gscript list",
			"# script bound to a specific Sheet",
			"agentio gscript list --parent 1Sheet...",
			"# standalone scripts (no container) — list and inspect parentId field",
			"agentio gscript list --limit 100",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.list(in.Option("parent"), jsvalue.ParseInt(in.Option("limit"))))
		},
		Format: formatList,
	}
}

// deleteCmd has no Format: Bun prints one console.log line after deleting.
// Without --force it only names the project on stderr and prints nothing.
func deleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "delete",
		Description: "Delete a script project (moves to Drive trash)",
		Access:      "write",
		Operation:   "delete script project",
		Arguments:   []plugins.ArgumentSpec{idArg},
		Options: []plugins.OptionSpec{
			{Flags: "--force", Description: "Skip confirmation"},
		},
		Examples: []string{
			"# confirm + delete",
			"agentio gscript delete 1abc...XYZ --force",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			id := in.Arg("id")
			if !in.Flag("force") {
				p, err := a.metadata(id)
				if err != nil {
					return nil, err
				}
				run.Log(fmt.Sprintf("About to delete script project: %s (%s)", p.Title, p.ScriptID))
				run.Log("Pass --force to confirm.")
				return nil, nil
			}
			if err := a.delete(id); err != nil {
				return nil, err
			}
			return "Deleted script project " + id, nil
		},
	}
}

func pullCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "pull",
		Description: "Download all script files to a local directory (writes .clasp.json)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{idArg, {Name: "dir", Description: "Local directory (default: cwd)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--force", Description: "Overwrite a directory whose .clasp.json points to a different scriptId"},
		},
		Examples: []string{
			"# pull into the current directory",
			"agentio gscript pull 1abc...XYZ",
			"# pull into a fresh folder",
			"agentio gscript pull 1abc...XYZ ./my-script",
			"# overwrite a directory pointing to a different script",
			"agentio gscript pull 1abc...XYZ ./my-script --force",
			"",
			"Writes Code.gs, appsscript.json, *.html files, plus .clasp.json with the scriptId.",
		},
		Prepare: plugins.Parse(preparePull),
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			id, target := in.Arg("id"), plugins.Prepared[pullTarget](run)
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			files, err := a.getContent(id)
			if err != nil {
				return nil, err
			}
			return plugins.Result(writePull(target.root, target.claspPath, id, files))
		},
		Format: formatPull,
	}
}

func pushCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "push",
		Description: "Upload all .gs/.html/appsscript.json files in a directory",
		Access:      "write",
		Prepare:     plugins.Parse(localProject),
		Operation:   "push script content",
		Arguments:   []plugins.ArgumentSpec{{Name: "dir", Description: "Local directory (default: cwd)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--id <scriptId>", Description: "Override scriptId from .clasp.json"},
		},
		Examples: []string{
			"# push current directory (uses .clasp.json)",
			"agentio gscript push",
			"# push a specific directory",
			"agentio gscript push ./my-script",
			"# push to a script id that's not in .clasp.json",
			"agentio gscript push ./my-script --id 1abc...XYZ",
			"",
			"Hidden files and .clasp.json are skipped. The push fails if appsscript.json is missing.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			local := plugins.Prepared[localFiles](run)
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			updated, err := a.updateContent(local.scriptID, local.files)
			if err != nil {
				return nil, err
			}
			return toPushed(local.scriptID, updated), nil
		},
		Format: formatPush,
	}
}

// getCmd prints the file's source as is (Bun process.stdout.write).
func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Print one script file to stdout",
		Access:      "read",
		Arguments: []plugins.ArgumentSpec{
			idArg,
			{Name: "file", Description: "File name (with or without extension, e.g. Code or Code.gs)", Required: true},
		},
		Examples: []string{
			"# print Code.gs to stdout",
			"agentio gscript get 1abc...XYZ Code",
			"# bare name and full filename both work",
			"agentio gscript get 1abc...XYZ Code.gs",
			"# the JSON manifest",
			"agentio gscript get 1abc...XYZ appsscript",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			id := in.Arg("id")
			files, err := a.getContent(id)
			if err != nil {
				return nil, err
			}
			bare := stripExt(in.Arg("file"))
			for _, f := range files {
				if f.Name == bare {
					return f.Source, nil
				}
			}
			names := make([]string, len(files))
			for i, f := range files {
				names[i] = f.Name
			}
			available := strings.Join(names, ", ")
			if available == "" {
				available = "(empty)"
			}
			return nil, run.Fail("NOT_FOUND", `No file named "`+bare+`" in script `+id, "Available: "+available)
		},
		Format:   formatSource,
		Verbatim: true,
	}
}

func putCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "put",
		Description: "Replace or add a single script file (--source, --from <path>, or - for stdin)",
		Access:      "write",
		Prepare:     plugins.Parse(putSource),
		Operation:   "update script content",
		Input:       "text",
		Arguments: []plugins.ArgumentSpec{
			idArg,
			{Name: "file", Description: "File name (with or without extension)", Required: true},
		},
		Options: []plugins.OptionSpec{
			{Flags: "--source <text>", Description: "Inline content"},
			{Flags: "--from <path>", Description: "Read content from a local file"},
		},
		Examples: []string{
			"# inline content",
			"agentio gscript put 1abc...XYZ Code --source 'function doIt(){}'",
			"# from a local file",
			"agentio gscript put 1abc...XYZ Code.gs --from ./Code.gs",
			"# from stdin",
			"echo 'function doIt(){}' | agentio gscript put 1abc...XYZ Code",
			"# add a new helper",
			"agentio gscript put 1abc...XYZ Helpers --source '// helpers go here'",
			"",
			"Type inference: extension on the file argument decides the API type",
			"(.gs=SERVER_JS, .html=HTML, .json=JSON-only-for-appsscript). If the",
			"file already exists in the project, its existing type is reused.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			source := plugins.Prepared[string](run)
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			id, name := in.Arg("id"), in.Arg("file")
			existing, err := a.getContent(id)
			if err != nil {
				return nil, err
			}
			next, err := putFile(existing, stripExt(name), strings.ToLower(nodefs.Extname(name)), source, run.Fail)
			if err != nil {
				return nil, err
			}
			updated, err := a.updateContent(id, next)
			if err != nil {
				return nil, err
			}
			return toPushed(id, updated), nil
		},
		Format: formatPush,
	}
}

// putFile replaces the source of the existing file named bare, or appends a
// new one typed by its extension (SERVER_JS without one). Only appsscript may
// be JSON.
func putFile(existing []file, bare, ext, source string, fail plugins.FailFunc) ([]file, error) {
	next := make([]file, 0, len(existing)+1)
	found := false
	for _, f := range existing {
		if f.Name == bare {
			f.Source = source
			found = true
		}
		next = append(next, f)
	}
	if found {
		return next, nil
	}
	typ := "SERVER_JS"
	if t, ok := extToType[ext]; ok {
		if t == "JSON" && bare != "appsscript" {
			return nil, fail("INVALID_PARAMS", `JSON files must be named "appsscript"`, "")
		}
		typ = t
	}
	return append(next, file{Name: bare, Type: typ, Source: source}), nil
}
