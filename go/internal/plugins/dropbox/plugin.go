// Package dropbox is the Dropbox service.
package dropbox

import (
	"context"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:         plugins.APIVersion,
		ID:                 "dropbox",
		DisplayName:        "Dropbox",
		Description:        "Use when interacting with Dropbox via the agentio CLI - list, search, download, upload, move, copy, delete, share links.",
		CommandDescription: "Dropbox operations",
		Profile: &plugins.ProfileSpec{
			ProfileDescription: "Profile name (defaults to the account email)",
			Setup:              setup,
			Validate:           validate,
			Reauthenticate:     reauth,
			ListInfo:           listInfo,
			SetupOptions: []plugins.OptionSpec{
				{Flags: "--app-key <key>", Description: "App key from the Dropbox App Console"},
			},
			Refresh: &plugins.RefreshSpec{
				SecretFields: []string{"refreshToken"},
				Applies:      applies,
				IsStale:      stale,
				Run:          refresh,
			},
		},
		Commands: []plugins.CommandSpec{
			listCmd(), getCmd(), searchCmd(), downloadCmd(), putCmd(), mkdirCmd(),
			moveCmd(), copyCmd(), deleteCmd(), linkCmd(), accountCmd(),
		},
	}
}

func listInfo(creds plugins.Credentials) string {
	if email := creds.StrValue("email"); email != "" {
		return " - " + email
	}
	return ""
}

func apiOf(ctx context.Context, run *plugins.RunContext) *api {
	return newAPI(ctx, run.Credentials, run.Fetch)
}

// jsParseInt is parseInt(s, 10): leading whitespace, an optional sign, then
// digits up to the first non-digit. No digits is NaN (ok false).
func jsParseInt(s string) (int, bool) {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	sign := 1
	if s != "" && (s[0] == '+' || s[0] == '-') {
		if s[0] == '-' {
			sign = -1
		}
		s = s[1:]
	}
	n, digits := 0, 0
	for digits < len(s) && s[digits] >= '0' && s[digits] <= '9' {
		n = n*10 + int(s[digits]-'0')
		digits++
	}
	if digits == 0 {
		return 0, false
	}
	return sign * n, true
}

func parseLimit(run *plugins.RunContext, value string) (int, error) {
	limit, ok := jsParseInt(value)
	if !ok || limit < 1 {
		return 0, run.Fail("INVALID_PARAMS", "--limit must be a positive number", "")
	}
	return limit, nil
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List a folder",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "path", Description: "Folder path (default: account root)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Maximum entries to return", DefaultValue: "100"},
			{Flags: "--recursive", Description: "Include everything below the folder"},
			{Flags: "--folders", Description: "Only show folders"},
		},
		Examples: []string{
			"# everything at the top level of the account",
			"agentio dropbox list",
			"# one folder",
			"agentio dropbox list /Documents",
			"# the whole tree below a folder",
			"agentio dropbox list /Documents --recursive --limit 500",
			"# only the subfolders",
			"agentio dropbox list /Documents --folders",
		},
		ExampleNotes: []string{
			"",
			`Paths are absolute and start at the Dropbox root, e.g. "/Documents/report.pdf".`,
			"Casing is preserved but matching is case-insensitive.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			limit, err := parseLimit(run, in.Option("limit"))
			if err != nil {
				return nil, err
			}
			path := in.Arg("path")
			entries, err := apiOf(ctx, run).list(path, limit, in.Flag("recursive"), in.Flag("folders"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			title := "Entries"
			if path != "" {
				title = "Entries in " + path
			}
			return entryList{title: title, entries: entries}, nil
		},
		Format: formatEntryList,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get metadata for a file or folder",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "path", Description: "File or folder path", Required: true}},
		Examples: []string{
			"# size, revision and modification time of a file",
			"agentio dropbox get /Documents/report.pdf",
			"# confirm a folder exists",
			"agentio dropbox get /Documents",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			e, err := apiOf(ctx, run).get(in.Arg("path"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return e, nil
		},
		Format: formatEntry,
	}
}

func searchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "search",
		Description: "Search for files and folders",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--query <text>", Required: true, Description: "Search text"},
			{Flags: "--path <path>", Description: "Restrict the search to a folder"},
			{Flags: "--limit <n>", Description: "Maximum results to return", DefaultValue: "20"},
			{Flags: "--filename-only", Description: "Match names only, not file contents"},
		},
		Examples: []string{
			"# search names and contents across the account",
			`agentio dropbox search --query "quarterly report"`,
			"# search inside one folder",
			"agentio dropbox search --query invoice --path /Accounting",
			"# match file names only",
			"agentio dropbox search --query 2026 --filename-only --limit 50",
		},
		ExampleNotes: []string{
			"",
			"Newly uploaded files can take a few minutes to become searchable.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			limit, err := parseLimit(run, in.Option("limit"))
			if err != nil {
				return nil, err
			}
			entries, err := apiOf(ctx, run).search(in.Option("query"), in.Option("path"), limit, in.Flag("filename-only"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return entryList{title: "Search Results", entries: entries}, nil
		},
		Format: formatEntryList,
	}
}

func downloadCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "download",
		Description: "Download a file, or a folder as a zip archive",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "path", Description: "File or folder path", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--output <path>", Description: "Local output path (default: the remote name)"},
		},
		Examples: []string{
			"# download a file next to the current directory",
			"agentio dropbox download /Documents/report.pdf",
			"# download to a chosen path",
			"agentio dropbox download /Documents/report.pdf --output ~/Desktop/report.pdf",
			"# download a whole folder (arrives as Documents.zip)",
			"agentio dropbox download /Documents",
			"# download a folder to a named archive",
			"agentio dropbox download /Photos/2026 --output ./photos-2026.zip",
		},
		ExampleNotes: []string{
			"",
			"Folder downloads are capped by Dropbox at 20 GB and 10,000 files.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			r, err := apiOf(ctx, run).download(in.Arg("path"), in.Option("output"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return r, nil
		},
		Format: formatDownloaded,
	}
}

func putCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "put",
		Description: "Upload a file",
		Access:      "write",
		Operation:   "upload a file",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-path", Description: "Local file path", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--path <path>", Description: "Destination path or folder (default: account root)"},
			{Flags: "--overwrite", Description: "Replace an existing file at the destination"},
		},
		Examples: []string{
			"# upload to the account root, keeping the local name",
			"agentio dropbox put ./report.pdf",
			"# upload into a folder (trailing slash keeps the local name)",
			"agentio dropbox put ./report.pdf --path /Documents/",
			"# upload under a different name",
			"agentio dropbox put ./out.csv --path /Reports/2026-results.csv",
			"# update a file that already exists",
			"agentio dropbox put ./report.pdf --path /Documents/report.pdf --overwrite",
		},
		ExampleNotes: []string{
			"",
			"Without --overwrite an existing destination is an error, never a silent replace.",
			"Files above 150 MB are uploaded in 8 MB chunks automatically.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			r, err := apiOf(ctx, run).upload(in.Arg("file-path"), in.Option("path"), in.Flag("overwrite"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return r, nil
		},
		Format: formatUploaded,
	}
}

func mkdirCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "mkdir",
		Description: "Create a folder",
		Access:      "write",
		Operation:   "create a folder",
		Arguments:   []plugins.ArgumentSpec{{Name: "path", Description: "Folder path to create", Required: true}},
		Examples: []string{
			"# create a folder at the root",
			"agentio dropbox mkdir /Reports",
			"# create a nested folder (parents are created as needed)",
			"agentio dropbox mkdir /Reports/2026/Q1",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			e, err := apiOf(ctx, run).mkdir(in.Arg("path"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return e, nil
		},
		Format: entryLine("Created folder: "),
	}
}

func relocateCmd(path, description, operation, endpoint, prefix string, examples []string) plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        path,
		Description: description,
		Access:      "write",
		Operation:   operation,
		Arguments: []plugins.ArgumentSpec{
			{Name: "from", Description: "Source path", Required: true},
			{Name: "to", Description: "Destination path", Required: true},
		},
		Examples: examples,
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			e, err := apiOf(ctx, run).relocate(endpoint, in.Arg("from"), in.Arg("to"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return e, nil
		},
		Format: entryLine(prefix),
	}
}

func moveCmd() plugins.CommandSpec {
	return relocateCmd("move", "Move or rename a file or folder", "move a file", "files/move_v2", "Moved to: ", []string{
		"# rename a file in place",
		"agentio dropbox move /Documents/draft.pdf /Documents/final.pdf",
		"# move a file to another folder",
		"agentio dropbox move /Inbox/scan.pdf /Documents/scan.pdf",
		"# move a whole folder",
		"agentio dropbox move /Inbox/2025 /Archive/2025",
	})
}

func copyCmd() plugins.CommandSpec {
	return relocateCmd("copy", "Copy a file or folder", "copy a file", "files/copy_v2", "Copied to: ", []string{
		"# copy a file",
		"agentio dropbox copy /Documents/report.pdf /Archive/report-2026.pdf",
		"# copy a folder and everything in it",
		"agentio dropbox copy /Templates /Projects/new-client",
	})
}

func deleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "delete",
		Description: "Delete a file or folder (recoverable from the Dropbox trash)",
		Access:      "write",
		Operation:   "delete a file",
		Arguments:   []plugins.ArgumentSpec{{Name: "path", Description: "File or folder path", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--force", Description: "Skip the confirmation prompt"},
		},
		Examples: []string{
			"# delete a file with a confirmation prompt",
			"agentio dropbox delete /Documents/old.pdf",
			"# delete without prompting",
			"agentio dropbox delete /Documents/old.pdf --force",
			"# delete a folder and all of its contents",
			"agentio dropbox delete /Archive/2019 --force",
		},
		ExampleNotes: []string{
			"",
			"Deleted items go to the Dropbox trash and stay recoverable for 30 days",
			"(180 days on business plans).",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a := apiOf(ctx, run)
			path := in.Arg("path")
			if !in.Flag("force") {
				e, err := a.get(path)
				if err != nil {
					return nil, failed(run.Fail, err)
				}
				what := "file"
				if e.Type == "folder" {
					what = "folder (and everything in it)"
				}
				confirmed, err := run.Confirm("Delete " + what + ` "` + e.Path + `"?`)
				if err != nil {
					// An answer that cannot be read: nothing is deleted or
					// printed. A closed stdin is an empty answer, so no.
					return nil, nil
				}
				if !confirmed {
					run.Log("Cancelled")
					return nil, nil
				}
			}
			e, err := a.remove(path)
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return e, nil
		},
		Format: entryLine("Deleted: "),
	}
}

func linkCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "link",
		Description: "Get a shareable link",
		Access:      "write",
		Operation:   "create a shared link",
		// A temporary link creates nothing, so Bun skips the write check for it.
		AccessFor: func(in plugins.CommandInput) string {
			if in.Flag("temporary") {
				return "read"
			}
			return "write"
		},
		Arguments: []plugins.ArgumentSpec{{Name: "path", Description: "File or folder path", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--temporary", Description: "Direct download URL that expires in 4 hours (files only)"},
		},
		Examples: []string{
			"# permanent share link (reuses the existing one if there is one)",
			"agentio dropbox link /Documents/report.pdf",
			"# share a folder",
			"agentio dropbox link /Photos/2026",
			"# direct download URL for a script to fetch, valid 4 hours",
			"agentio dropbox link /Documents/report.pdf --temporary",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a := apiOf(ctx, run)
			var l link
			var err error
			if in.Flag("temporary") {
				l, err = a.temporaryLink(in.Arg("path"))
			} else {
				l, err = a.sharedLink(in.Arg("path"))
			}
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return l, nil
		},
		Format: formatLink,
	}
}

func accountCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "account",
		Description: "Show the connected Dropbox account",
		Access:      "read",
		Examples: []string{
			"# which account this profile is connected to",
			"agentio dropbox account",
		},
		Run: func(ctx context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
			acct, err := apiOf(ctx, run).account()
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return acct, nil
		},
		Format: formatAccount,
	}
}
