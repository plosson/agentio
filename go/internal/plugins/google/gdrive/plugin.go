// Package gdrive is the Google Drive service.
package gdrive

import (
	"context"
	"fmt"
	"regexp"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:         plugins.APIVersion,
		ID:                 "gdrive",
		DisplayName:        "Google Drive",
		Description:        "Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation.",
		CommandDescription: "Google Drive operations",
		Profile: &plugins.ProfileSpec{
			ProfileDescription: "Profile name (auto-detected from email if not provided)",
			Setup:              setup,
			Validate:           validate,
			Reauthenticate:     reauthenticate,
			Refresh:            google.Camel.RefreshSpec(),
			ListInfo:           listInfo,
			SetupOptions: []plugins.OptionSpec{
				{Flags: "--readonly", Description: "Create a read-only profile (skip access level prompt)"},
				{Flags: "--full", Description: "Create a full access profile (skip access level prompt)"},
			},
		},
		Commands: []plugins.CommandSpec{
			listCmd(), foldersCmd(), getCmd(), searchCmd(), downloadCmd(), putCmd(), copyCmd(),
			mkdirCmd(), renameCmd(), moveCmd(), trashCmd(), permissionsCmd(), shareCmd(), unshareCmd(),
		},
	}
}

// oauthService is the Scopes key for an access level.
func oauthService(accessLevel string) string {
	if accessLevel == "full" {
		return "gdrive-full"
	}
	return "gdrive-readonly"
}

// setup is gdriveProfileAdd: the access level from --readonly, --read-only or
// --full, else asked, then OAuth with that level's scopes.
func setup(ctx context.Context, opts plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("Google Drive Setup\n")
	var accessLevel string
	switch {
	case opts.Flag("readonly") || opts.ReadOnly:
		accessLevel = "readonly"
	case opts.Flag("full"):
		accessLevel = "full"
	default:
		setup.Log("Access level options:")
		setup.Log("  1. Read-only  - List, search, download files")
		setup.Log("  2. Full       - Read-only + upload, create folders, modify files\n")
		choice, _ := setup.Prompt("? Select access level (1 or 2): ", false)
		accessLevel = "readonly"
		if jsvalue.Trim(choice) == "2" {
			accessLevel = "full"
		}
	}
	setup.Log(fmt.Sprintf("\nStarting OAuth flow (%s access)...\n", accessLevel))
	tokens, err := google.PerformOAuth(ctx, setup, oauthService(accessLevel))
	if err != nil {
		return nil, err
	}
	email, err := google.FetchUserEmail(ctx, setup.Fetch, tokens.AccessToken)
	if err != nil {
		return nil, google.EmailFailure(setup, err)
	}
	creds := google.Camel.Merge(nil, tokens)
	creds.Set("email", email)
	creds.Set("accessLevel", accessLevel)
	access := "Read-only"
	if accessLevel == "full" {
		access = "Full (read & write)"
	}
	return &plugins.SetupResult{
		Credentials:          creds,
		SuggestedProfileName: email,
		Info:                 "Email: " + email + "\nAPI Access: " + access + "\nTest with: agentio gdrive list",
	}, nil
}

// reauthenticate keeps the profile's access level (readonly when missing) and
// asks for that level's scopes again.
func reauthenticate(ctx context.Context, creds plugins.Credentials, profileName string, setup *plugins.SetupContext) (plugins.Credentials, error) {
	accessLevel, _ := creds.Value("accessLevel").(string)
	if accessLevel == "" {
		accessLevel = "readonly"
	}
	setup.Log(fmt.Sprintf("\nRe-authenticating gdrive / %s...", profileName))
	tokens, err := google.PerformOAuth(ctx, setup, oauthService(accessLevel))
	if err != nil {
		return nil, err
	}
	email, err := google.FetchUserEmail(ctx, setup.Fetch, tokens.AccessToken)
	if err != nil {
		return nil, err
	}
	setup.Log(fmt.Sprintf("  Done (%s, %s)", email, accessLevel))
	out := google.Camel.Merge(creds, tokens)
	out.Set("email", email)
	out.Set("accessLevel", accessLevel)
	return out, nil
}

// validate is GDriveClient.validate: one file listed; the account is the stored email.
func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	svc, err := google.DriveService(ctx, run)
	if err != nil {
		return google.ValidationFailure(err), nil
	}
	if _, err := svc.Files.List().PageSize(1).Context(ctx).Do(); err != nil {
		return google.ValidationFailure(err), nil
	}
	email, _ := run.Credentials.Value("email").(string)
	return plugins.ValidationResult{Valid: true, Info: email}, nil
}

// listInfo is Bun getExtraInfo: ` - ${email} (${access})`.
func listInfo(creds plugins.Credentials) string {
	if creds == nil {
		return ""
	}
	access := "read-only"
	if creds.Value("accessLevel") == "full" {
		access = "full"
	}
	email, ok := creds.Get("email")
	if !ok {
		email = "undefined"
	}
	return " - " + jsvalue.String(email) + " (" + access + ")"
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List files",
		Access:      "read",
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--limit <n>", Description: "Number of files", DefaultValue: "20"},
			{Flags: "--folder <id>", Description: `Folder ID to list (use "root" for root folder)`},
			{Flags: "--query <query>", Description: "Drive API query filter"},
			{Flags: "--order <field>", Description: "Order by field", DefaultValue: "modifiedTime desc"},
			{Flags: "--trash", Description: "Include trashed files"},
		},
		Examples: []string{
			"# 20 most recently modified files",
			"agentio gdrive list",
			"# files inside a specific folder",
			"agentio gdrive list --folder 1A2bCdEfGhIjKlMnOpQrStUvWxYz",
			"# only PDFs",
			`agentio gdrive list --query "mimeType = 'application/pdf'"`,
			"# files you own, sorted by name",
			`agentio gdrive list --query "'me' in owners" --order "name"`,
		},
		ExampleNotes: []string{
			"",
			"Query syntax: name contains '...', mimeType = '...', 'me' in owners,",
			"modifiedTime > 'YYYY-MM-DD', starred = true, shared = true.",
			"Combine with 'and'/'or'.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			files, err := a.list(listOptions{
				limit:        jsvalue.ParseInt(in.Option("limit")),
				folderID:     in.Option("folder"),
				query:        in.Option("query"),
				orderBy:      in.Option("order"),
				includeTrash: in.Flag("trash"),
			})
			return plugins.Result(fileList{Title: "Files", Files: files}, err)
		},
		Format: formatFileList,
	}
}

func foldersCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "folders",
		Description: "List folders",
		Access:      "read",
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--limit <n>", Description: "Number of folders", DefaultValue: "20"},
			{Flags: "--parent <id>", Description: `Parent folder ID (use "root" for root folder)`},
			{Flags: "--query <query>", Description: "Additional query filter"},
		},
		Examples: []string{
			"# 20 most recent folders",
			"agentio gdrive folders",
			"# folders directly under My Drive root",
			"agentio gdrive folders --parent root",
			"# subfolders of a specific folder",
			"agentio gdrive folders --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz",
			"# filter by name",
			`agentio gdrive folders --query "name contains 'archive'"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			files, err := a.listFolders(jsvalue.ParseInt(in.Option("limit")), in.Option("parent"), in.Option("query"))
			return plugins.Result(fileList{Title: "Folders", Files: files}, err)
		},
		Format: formatFileList,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get file metadata",
		Options:     []plugins.OptionSpec{plugins.ProfileOption("Profile name")},
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-id-or-url", Description: "File ID or URL", Required: true}},
		Examples: []string{
			"# metadata by file ID",
			"agentio gdrive get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"# metadata from a full Drive URL",
			"agentio gdrive get https://drive.google.com/file/d/1A2bCdEf.../view",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.get(in.Arg("file-id-or-url")))
		},
		Format: formatFile,
	}
}

func searchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "search",
		Description: "Search for files",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--query <text>", Required: true, Description: "Search text (searches name and content)"},
			plugins.ProfileOption("Profile name"),
			{Flags: "--limit <n>", Description: "Number of results", DefaultValue: "20"},
			{Flags: "--type <mime>", Description: "Filter by MIME type"},
			{Flags: "--folder <id>", Description: "Search within folder"},
		},
		Examples: []string{
			"# full-text search across name and content",
			`agentio gdrive search --query "quarterly report"`,
			"# only PDFs containing the phrase",
			`agentio gdrive search --query "invoice" --type application/pdf`,
			"# restrict to a folder, return more results",
			`agentio gdrive search --query "design" --folder 1A2bCdEf... --limit 50`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			files, err := a.search(in.Option("query"), in.Option("type"), jsvalue.ParseInt(in.Option("limit")), in.Option("folder"))
			return plugins.Result(fileList{Title: "Search Results", Files: files}, err)
		},
		Format: formatFileList,
	}
}

func downloadCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "download",
		Description: "Download a file (or export Google Workspace files)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-id-or-url", Description: "File ID or URL", Required: true}},
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--output <path>", Required: true, Description: "Output file path"},
			{Flags: "--export <format>", Description: "Export format for Google Workspace files (pdf, docx, xlsx, csv, pptx, txt, etc.)"},
		},
		Examples: []string{
			"# download a binary file as-is",
			"agentio gdrive download 1A2bCdEf... --output ./photo.jpg",
			"# export a Google Doc as PDF",
			"agentio gdrive download 1A2bCdEf... --output report.pdf --export pdf",
			"# export a Google Sheet as CSV",
			"agentio gdrive download 1A2bCdEf... --output data.csv --export csv",
			"# export Google Slides as PowerPoint",
			"agentio gdrive download 1A2bCdEf... --output deck.pptx --export pptx",
		},
		ExampleNotes: []string{
			"",
			"Export formats: Docs -> pdf|docx|odt|txt|html|rtf, Sheets -> xlsx|csv|pdf|ods|tsv,",
			"Slides -> pptx|pdf|odp|txt, Drawing -> pdf|png|jpeg|svg.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.download(in.Arg("file-id-or-url"), in.Option("output"), in.Option("export")))
		},
		Format: formatDownloaded,
	}
}

func putCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "put",
		Description: "Upload a file to Google Drive",
		Access:      "write",
		Operation:   "upload file",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-path", Description: "Local file path", Required: true}},
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--name <name>", Description: "Name for the file in Drive (defaults to local filename)"},
			{Flags: "--folder <id>", Description: "Folder ID to upload to"},
			{Flags: "--type <mime>", Description: "MIME type (auto-detected if not specified)"},
			{Flags: "--convert", Description: "Convert to Google Workspace format (Doc, Sheet, or Slides)"},
			{Flags: "--public", Description: "Share with anyone as reader after upload (shorthand for share --anyone)"},
		},
		Examples: []string{
			"# upload a file to My Drive root",
			"agentio gdrive put ./report.pdf",
			"# upload into a specific folder with a custom name",
			`agentio gdrive put ./out.csv --folder 1A2bCdEf... --name "results.csv"`,
			"# upload and convert .docx to a native Google Doc",
			"agentio gdrive put report.docx --convert",
			"# upload and convert .xlsx to a native Google Sheet",
			"agentio gdrive put data.xlsx --convert",
			"# upload an image and make it publicly accessible (for Docs/Slides API image insertion)",
			"agentio gdrive put banner.png --public",
		},
		ExampleNotes: []string{
			"",
			"Conversion: docx/doc/odt/txt/html/rtf -> Google Doc,",
			"xlsx/xls/ods/csv/tsv -> Google Sheet, pptx/ppt/odp -> Google Slides.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			result, err := a.upload(in.Arg("file-path"), in.Option("name"), in.Option("folder"), in.Option("type"), in.Flag("convert"))
			if err != nil {
				return nil, err
			}
			if in.Flag("public") {
				// Bun printed the upload before the share (extractFileId
				// reads result.id, outside the share's try) failed.
				id := result.Value("id")
				if jsvalue.Nullish(id) {
					return result, jsvalue.TypeError(id, "fileIdOrUrl.match")
				}
				share, err := a.share(jsvalue.String(id), jsvalue.String(id), shareOptions{kind: "anyone", role: "reader"})
				if err != nil {
					return result, err
				}
				result.Set("share", share.Result)
			}
			return result, nil
		},
		Format: formatUploaded,
	}
}

func copyCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "copy",
		Description: "Copy a file (server-side clone via Drive API)",
		Access:      "write",
		Operation:   "copy file",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-id-or-url", Description: "File ID or URL", Required: true}},
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--name <name>", Description: `Title for the copy (default: "Copy of <original>")`},
			{Flags: "--folder <id>", Description: "Destination folder ID (default: same as source)"},
		},
		Examples: []string{
			`# clone a Google Doc into the same folder (default name: "Copy of ...")`,
			"agentio gdrive copy 1A2bCdEf...",
			"# clone with a custom title",
			`agentio gdrive copy 1A2bCdEf... --name "Q2 report (working copy)"`,
			"# clone into a different folder",
			"agentio gdrive copy 1A2bCdEf... --folder 1XyZaBc...",
			"# clone with custom title into a specific folder",
			`agentio gdrive copy https://docs.google.com/document/d/1A2bCdEf.../edit \`,
			`  --name "Draft v2" --folder 1XyZaBc...`,
		},
		ExampleNotes: []string{
			"",
			"Server-side copy preserves layout, smart chips, and native blocks",
			"exactly — no re-rendering. Comments are not carried over.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.copy(in.Arg("file-id-or-url"), in.Option("name"), in.Option("folder")))
		},
		Format: formatCopied,
	}
}

func mkdirCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "mkdir",
		Description: "Create a folder",
		Access:      "write",
		Operation:   "create folder",
		Arguments:   []plugins.ArgumentSpec{{Name: "name", Description: "Folder name", Required: true}},
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--parent <id>", Description: "Parent folder ID or URL (default: My Drive root)"},
		},
		Examples: []string{
			"# create a folder in My Drive root",
			`agentio gdrive mkdir "Reports"`,
			"# create a subfolder inside an existing folder",
			`agentio gdrive mkdir "2026" --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.mkdir(in.Arg("name"), in.Option("parent")))
		},
		Format: formatCreatedFolder,
	}
}

func renameCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "rename",
		Description: "Rename a file or folder",
		Options:     []plugins.OptionSpec{plugins.ProfileOption("Profile name")},
		Access:      "write",
		Operation:   "rename file",
		Arguments: []plugins.ArgumentSpec{
			{Name: "file-id-or-url", Description: "File or folder ID or URL", Required: true},
			{Name: "new-name", Description: "New name", Required: true},
		},
		Examples: []string{
			"# rename a file by ID",
			`agentio gdrive rename 1A2bCdEfGhIjKlMnOpQrStUvWxYz "report-final.pdf"`,
			"# rename a folder from a full Drive URL",
			`agentio gdrive rename https://drive.google.com/drive/folders/1A2bCdEf... "Archive 2025"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.rename(in.Arg("file-id-or-url"), in.Arg("new-name")))
		},
		Format: fileLine("Renamed: "),
	}
}

func moveCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "move",
		Description: "Move a file or folder to another folder",
		Options:     []plugins.OptionSpec{plugins.ProfileOption("Profile name")},
		Access:      "write",
		Operation:   "move file",
		Arguments: []plugins.ArgumentSpec{
			{Name: "file-id-or-url", Description: "File or folder ID or URL", Required: true},
			{Name: "folder-id-or-url", Description: `Destination folder ID or URL (use "root" for My Drive root)`, Required: true},
		},
		Examples: []string{
			"# move a file into a folder",
			"agentio gdrive move 1A2bCdEfGhIjKlMnOpQrStUvWxYz 1XyZaBcDeFgHiJkLmNoPqRsTuVw",
			"# move a folder (and its contents) into another folder",
			"agentio gdrive move https://drive.google.com/drive/folders/1A2bCdEf... 1XyZaBc...",
			"# move a file back to My Drive root",
			"agentio gdrive move 1A2bCdEfGhIjKlMnOpQrStUvWxYz root",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.move(in.Arg("file-id-or-url"), in.Arg("folder-id-or-url")))
		},
		Format: formatMoved,
	}
}

func trashCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "trash",
		Description: "Move a file to the trash",
		Options:     []plugins.OptionSpec{plugins.ProfileOption("Profile name")},
		Access:      "write",
		Operation:   "trash file",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-id-or-url", Description: "File ID or URL", Required: true}},
		Examples: []string{
			"# move a file to the trash by ID",
			"agentio gdrive trash 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"# move a file to the trash from a full Drive URL",
			"agentio gdrive trash https://docs.google.com/document/d/1A2bCdEf.../edit",
		},
		ExampleNotes: []string{
			"",
			"Trashed files stay recoverable in Drive's trash for 30 days",
			"before Google deletes them permanently.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.trash(in.Arg("file-id-or-url")))
		},
		Format: fileLine("Trashed: "),
	}
}

func permissionsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "permissions",
		Description: "List permissions on a file",
		Options:     []plugins.OptionSpec{plugins.ProfileOption("Profile name")},
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-id-or-url", Description: "File ID or URL", Required: true}},
		Examples: []string{
			"# list all permissions on a file",
			"agentio gdrive permissions 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			perms, err := a.permissions(in.Arg("file-id-or-url"))
			if err != nil {
				return nil, err
			}
			return perms, permissionsError(perms)
		},
		Format: formatPermissions,
	}
}

// shareTarget is the one of --anyone, --user, --domain, --group given (Bun
// checks truthiness, so an empty value counts as absent).
func shareTarget(in plugins.CommandInput) (kind string, count int) {
	for _, name := range []string{"anyone", "user", "domain", "group"} {
		if jsvalue.Truthy(in.Options[name]) {
			if count == 0 {
				kind = name
			}
			count++
		}
	}
	return kind, count
}

// shareKind is Bun's checks before getGDriveClient; it returns the target kind.
func shareKind(in plugins.CommandInput, fail plugins.FailFunc) (string, error) {
	kind, count := shareTarget(in)
	if count == 0 {
		return "", fail("INVALID_PARAMS", "Specify one of --anyone, --user, --domain, or --group", "")
	}
	if count > 1 {
		return "", fail("INVALID_PARAMS", "--anyone, --user, --domain, and --group are mutually exclusive", "")
	}
	if in.Flag("allow-discovery") && !in.Flag("anyone") {
		return "", fail("INVALID_PARAMS", "--allow-discovery only applies with --anyone", "")
	}
	switch role := in.Option("role"); role {
	case "reader", "commenter", "writer":
		return kind, nil
	default:
		return "", fail("INVALID_PARAMS", "Invalid role: "+role, "Use reader, commenter, or writer")
	}
}

var shareFileIDPatterns = []*regexp.Regexp{
	regexp.MustCompile(`/file/d/([a-zA-Z0-9_-]+)`),
	regexp.MustCompile(`id=([a-zA-Z0-9_-]+)`),
}

// printedFileID is the id Bun's share command puts in the public URL: unlike
// extractFileID it ignores /folders/ URLs.
func printedFileID(fileIDOrURL string) string {
	for _, p := range shareFileIDPatterns {
		if m := p.FindStringSubmatch(fileIDOrURL); m != nil {
			return m[1]
		}
	}
	return fileIDOrURL
}

func shareCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "share",
		Description: "Share a file by creating a permission",
		Access:      "write",
		Prepare:     plugins.Parse(shareKind),
		Operation:   "share file",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-id-or-url", Description: "File ID or URL", Required: true}},
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--anyone", Description: "Share via link (type=anyone)"},
			{Flags: "--user <email>", Description: "Share with a specific user"},
			{Flags: "--domain <domain>", Description: "Share with an entire domain"},
			{Flags: "--group <email>", Description: "Share with a group"},
			{Flags: "--role <role>", Description: "Permission role: reader, commenter, writer", DefaultValue: "reader"},
			{Flags: "--notify", Description: "Send notification email (default: off)"},
			{Flags: "--message <text>", Description: "Message body for notification email (requires --notify)"},
			{Flags: "--allow-discovery", Description: "Make file findable via search (only with --anyone)"},
		},
		Examples: []string{
			"# make a file publicly accessible via link (e.g. for Docs/Slides API image insertion)",
			"agentio gdrive share 1A2bCdEf... --anyone",
			"# share with a specific user as writer",
			"agentio gdrive share 1A2bCdEf... --user alice@example.com --role writer",
			"# share with a user and send a notification email",
			`agentio gdrive share 1A2bCdEf... --user alice@example.com --notify --message "Here's the file"`,
			"# share with an entire domain",
			"agentio gdrive share 1A2bCdEf... --domain example.com --role reader",
			"# make publicly discoverable via search",
			"agentio gdrive share 1A2bCdEf... --anyone --allow-discovery",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			kind := plugins.Prepared[string](run)
			email := in.Option("user")
			if email == "" {
				email = in.Option("group")
			}
			fileIDOrURL := in.Arg("file-id-or-url")
			return plugins.Result(a.share(fileIDOrURL, printedFileID(fileIDOrURL), shareOptions{
				kind:               kind,
				role:               in.Option("role"),
				emailAddress:       email,
				domain:             in.Option("domain"),
				emailMessage:       in.OptionPtr("message"),
				notify:             in.Flag("notify"),
				allowFileDiscovery: in.Flag("allow-discovery"),
			}))
		},
		Format: formatShared,
	}
}

// checkUnshare is Bun's checks before getGDriveClient.
func checkUnshare(in plugins.CommandInput, fail plugins.FailFunc) error {
	byID, anyone := in.Option("permission-id") != "", in.Flag("anyone")
	if !byID && !anyone {
		return fail("INVALID_PARAMS", "Specify --permission-id or --anyone", "")
	}
	if byID && anyone {
		return fail("INVALID_PARAMS", "--permission-id and --anyone are mutually exclusive", "")
	}
	return nil
}

func unshareCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "unshare",
		Description: "Remove a permission from a file",
		Access:      "write",
		Prepare:     plugins.Check(checkUnshare),
		Operation:   "remove permission",
		Arguments:   []plugins.ArgumentSpec{{Name: "file-id-or-url", Description: "File ID or URL", Required: true}},
		Options: []plugins.OptionSpec{
			plugins.ProfileOption("Profile name"),
			{Flags: "--permission-id <id>", Description: "Permission ID to remove"},
			{Flags: "--anyone", Description: "Remove the anyone-with-link permission"},
		},
		Examples: []string{
			"# remove anyone-with-link access",
			"agentio gdrive unshare 1A2bCdEf... --anyone",
			"# remove a specific permission by ID",
			"agentio gdrive unshare 1A2bCdEf... --permission-id AKioiA...",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			fileIDOrURL := in.Arg("file-id-or-url")
			var permissionID any = in.Option("permission-id")
			if in.Flag("anyone") {
				perms, err := a.permissions(fileIDOrURL)
				if err != nil {
					return nil, err
				}
				found := false
				for _, p := range perms {
					if jsvalue.StrictEqual(jsvalue.Member(p, "type"), "anyone") {
						permissionID, found = jsvalue.Member(p, "id"), true
						break
					}
				}
				if !found {
					return nil, run.Fail("NOT_FOUND", "No anyone-with-link permission found on this file", "")
				}
			}
			if err := a.unshare(fileIDOrURL, permissionID); err != nil {
				return nil, err
			}
			return unshared{FileID: extractFileID(fileIDOrURL), PermissionID: jsvalue.String(permissionID)}, nil
		},
		Format: formatUnshared,
	}
}
