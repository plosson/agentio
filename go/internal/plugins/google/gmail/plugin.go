// Package gmail is the Gmail service.
package gmail

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	osexec "os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "gmail",
		DisplayName: "Gmail",
		Description: "Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export.",
		Profile: &plugins.ProfileSpec{
			Setup:          google.SnakeSetup("gmail", "Gmail", "Could not fetch email from Gmail"),
			Validate:       validate,
			Reauthenticate: google.Reauthenticate("gmail", google.Snake),
			Refresh:        google.Snake.RefreshSpec(),
			ListInfo:       google.EmailListInfo,
		},
		Commands: []plugins.CommandSpec{
			listCmd(), getCmd(), searchCmd(), sendCmd(), draftCmd(), draftDeleteCmd(),
			archiveCmd(), markCmd(),
			labelsListCmd(), labelsCreateCmd(), labelsDeleteCmd(), labelsRenameCmd(),
			filtersListCmd(), filtersGetCmd(), filtersCreateCmd(), filtersDeleteCmd(),
			labelCmd(), attachmentCmd(), exportCmd(),
		},
	}
}

// validate is GmailClient.validate: the profile's address is the account.
func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	a, err := apiFrom(ctx, run)
	if err != nil {
		return google.ValidationFailure(err), nil
	}
	email, err := a.getUserEmail()
	if err != nil {
		return google.ValidationFailure(err), nil
	}
	return plugins.ValidationResult{Valid: true, Info: email}, nil
}

func args(in plugins.CommandInput, name string) []string {
	values, _ := in.Args[name].([]string)
	return values
}

// collectIDs is Bun collectIds: the arguments, else whitespace-separated ids
// on stdin.
func collectIDs(positional []string, in plugins.CommandInput) []string {
	if len(positional) > 0 {
		return positional
	}
	return strings.FieldsFunc(plugins.Stdin(in), jsvalue.IsSpace)
}

// chunkOptions is Bun parseChunkOpts: `options.x ?? default`, so a given ""
// parses to NaN rather than taking the default.
func chunkOptions(in plugins.CommandInput) (chunkSize, maxRetries int) {
	orDefault := func(name, def string) string {
		if value, given := in.LookupOption(name); given {
			return value
		}
		return def
	}
	size := jsvalue.ParseInt(orDefault("chunk-size", "1000"))
	if math.IsNaN(size) || size == 0 {
		size = 1000
	}
	retries := jsvalue.ParseInt(orDefault("max-retries", "5"))
	if math.IsNaN(retries) {
		retries = 0
	}
	return int(math.Min(math.Max(size, 1), 1000)), int(math.Max(retries, 0))
}

// dryRun is a NoProfileFor: Bun prints the dry-run plan before
// getGmailClient, so it needs no profile.
func dryRun(in plugins.CommandInput) bool {
	return in.Flag("dry-run")
}

var composeOptions = []plugins.OptionSpec{
	{Flags: "--to <email>", Description: "Recipient (repeatable, required unless --reply-to)", Repeatable: true},
	{Flags: "--cc <email>", Description: "CC recipient (repeatable)", Repeatable: true},
	{Flags: "--bcc <email>", Description: "BCC recipient (repeatable)", Repeatable: true},
	{Flags: "--subject <subject>", Description: "Email subject (required unless --reply-to)"},
	{Flags: "--subject-file <path>", Description: "Read subject from a UTF-8 file (preferred for agents; avoids shell quoting)"},
	{Flags: "--body <body>", Description: `Email body (omit or pass "-" to read from stdin)`},
	{Flags: "--body-file <path>", Description: "Read body from a UTF-8 file (preferred for agents; avoids shell quoting)"},
	{Flags: "--spec <path.json>", Description: "Compose from JSON file {to,cc,bcc,subject,body,attachments}; flags override"},
	{Flags: "--html", Description: "Treat body as HTML"},
	{Flags: "--reply-to <thread-id>", Description: "Thread ID to reply to (derives to/subject from thread)"},
	{Flags: "--attachment <path>", Description: "File to attach (repeatable)", Repeatable: true},
	{Flags: "--inline <cid:path>", Description: "Inline image (repeatable, format: contentId:filepath). Supports PNG, JPG, GIF only (not SVG)", Repeatable: true},
}

func checkCompose(in plugins.CommandInput, fail plugins.FailFunc) error {
	_, err := parseSendOptions(in, fail)
	return err
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List messages",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Number of messages", DefaultValue: "10"},
			{Flags: "--query <query>", Description: `Gmail search query (see "gmail search --help" for syntax)`},
			{Flags: "--label <label>", Description: "Filter by label (repeatable)", Repeatable: true},
		},
		Examples: []string{
			"# 10 most recent messages",
			"agentio gmail list",
			"# 25 most recent in the inbox",
			"agentio gmail list --limit 25 --label INBOX",
			"# unread messages from the last week",
			`agentio gmail list --query "is:unread newer_than:7d"`,
			"# use a specific profile",
			"agentio gmail list --profile alice@example.com",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.list(jsvalue.ParseInt(in.Option("limit")), in.Option("query"), in.List("label")))
		},
		Format: render,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get a message",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "message-id", Description: "Message ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--format <format>", Description: "Body format: text, html, or raw", DefaultValue: "text"},
			{Flags: "--body-only", Description: "Output only the message body"},
		},
		Examples: []string{
			"# full message with headers",
			"agentio gmail get 18c4f1a2b3d",
			"# plain-text body only (good for piping to a file)",
			"agentio gmail get 18c4f1a2b3d --body-only > message.txt",
			"# raw HTML body",
			"agentio gmail get 18c4f1a2b3d --format html --body-only",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			m, err := a.get(in.Arg("message-id"), in.Option("format"))
			if err != nil {
				return nil, err
			}
			if in.Flag("body-only") {
				return *m.Body, nil
			}
			return m, nil
		},
		Format: render,
	}
}

func searchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "search",
		Description: "Search messages using Gmail query syntax",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--query <query>", Description: "Search query"},
			{Flags: "--limit <n>", Description: "Max results (capped at 10000; >100 returns IDs only without per-message metadata)", DefaultValue: "10"},
			{Flags: "--ids-only", Description: "Print one message ID per line (pipe-friendly into archive/label)"},
		},
		Examples: []string{
			"# unread mail from a specific sender in the last week",
			`agentio gmail search --query "from:alice@example.com is:unread newer_than:7d"`,
			"# messages with attachments after a date",
			`agentio gmail search --query "has:attachment after:2024/01/01" --limit 25`,
			"# subject keyword in inbox, excluding spam",
			`agentio gmail search --query "subject:invoice label:inbox -label:spam"`,
			"# exact phrase across all mail",
			`agentio gmail search --query '"quarterly report"'`,
			"# bulk pipe: archive everything matching a query",
			`agentio gmail search --query "from:noreply@example.com older_than:6m" --limit 5000 --ids-only \`,
			"  | agentio gmail archive",
			"",
			"Query syntax: from:, to:, cc:, subject:, label:, is:unread|starred|important,",
			"has:attachment, after:YYYY/MM/DD, before:YYYY/MM/DD, newer_than:7d, older_than:1m.",
			"Combine with spaces (AND), OR, or - to negate.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := plugins.RequireOptions(in, run.Fail, "--query <query>"); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			result, err := a.list(jsvalue.ParseInt(in.Option("limit")), in.Option("query"), nil)
			if err != nil {
				return nil, err
			}
			if in.Flag("ids-only") {
				ids := idList{}
				for _, m := range result.Messages {
					ids = append(ids, m.ID)
				}
				return ids, nil
			}
			return result, nil
		},
		Format: render,
	}
}

func sendCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "send",
		Description: "Send an email",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(checkCompose),
		Operation:   "send email",
		Input:       "text",
		Options:     composeOptions,
		Examples: []string{
			"# plain-text email",
			`agentio gmail send --to alice@example.com --subject "Hello" --body "Hi Alice!"`,
			"# body from stdin (great for piping)",
			`echo "Sent via pipe" | agentio gmail send --to alice@example.com --subject "Note"`,
			"# preferred for agents: subject/body from UTF-8 files",
			`agentio gmail send --to alice@example.com \`,
			"  --subject-file ./subject.txt --body-file ./body.txt",
			"# reply within an existing thread (to/subject derived from thread)",
			`agentio gmail send --reply-to 18c4f1a2b3d --body "Thanks!"`,
			"# HTML body with an attachment and an inline image",
			`agentio gmail send --to alice@example.com --cc bob@example.com \`,
			`  --subject "Report" --html \`,
			`  --body '<p>See chart:</p><img src="cid:chart1">' \`,
			"  --attachment ./report.pdf --inline chart1:./chart.png",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			o, err := parseSendOptions(in, run.Fail)
			if err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.send(o))
		},
		Format: render,
	}
}

func draftCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "draft",
		Description: "Create an email draft (or update an existing one with [draft-id])",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(checkCompose),
		Operation:   "create draft",
		OperationFor: func(in plugins.CommandInput) string {
			if in.Arg("draft-id") != "" {
				return "update draft"
			}
			return "create draft"
		},
		Input:     "text",
		Arguments: []plugins.ArgumentSpec{{Name: "draft-id", Description: "Existing draft ID to replace (omit to create a new draft)"}},
		Options:   composeOptions,
		Examples: []string{
			"# save a draft for later editing in Gmail",
			`agentio gmail draft --to alice@example.com --subject "Hello" --body "Draft body"`,
			"# preferred for agents: subject/body from UTF-8 files (avoids shell quoting bugs)",
			`agentio gmail draft --to alice@example.com \`,
			"  --subject-file ./subject.txt --body-file ./body.txt",
			"# or a single JSON spec (flags still override individual fields)",
			"agentio gmail draft --spec ./draft.json",
			"# update an existing draft (replaces its entire content)",
			`agentio gmail draft r-1234567890 --to alice@example.com --subject "Hello" --body "Revised body"`,
			"# draft a reply within an existing thread",
			`agentio gmail draft --reply-to 18c4f1a2b3d --body "Draft reply"`,
			"# draft with attachment, body from stdin",
			`cat message.txt | agentio gmail draft --to alice@example.com \`,
			`  --subject "Notes" --attachment ./notes.pdf`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			o, err := parseSendOptions(in, run.Fail)
			if err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.saveDraft(in.Arg("draft-id"), o))
		},
		Format: render,
	}
}

func draftDeleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "draft delete",
		Description: "Delete (discard) one or more drafts",
		Access:      "write",
		Operation:   "delete draft",
		Arguments:   []plugins.ArgumentSpec{{Name: "draft-id", Description: "Draft ID(s) to delete", Required: true, Variadic: true}},
		Examples: []string{
			"# discard a draft",
			"agentio gmail draft delete r-1234567890",
			"# discard several at once",
			"agentio gmail draft delete r-123... r-456...",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return eachID(args(in, "draft-id"), func(id string) error { return a.deleteDraft(id) },
				func(id string, err error) { run.Log(fmt.Sprintf("Failed to delete draft %s: %s", id, err.Error())) },
				func(ids []string) any { return draftsDeleted(ids) })
		},
		Format: render,
	}
}

// eachID is Bun's per-id delete loop: a failure is logged and the rest still
// run, and any failure ends with process.exit(5) after the successes print.
func eachID(ids []string, do func(string) error, logFailure func(string, error), result func([]string) any) (any, error) {
	var done []string
	failures := 0
	for _, id := range ids {
		if err := do(id); err != nil {
			failures++
			logFailure(id, err)
			continue
		}
		done = append(done, id)
	}
	var value any
	if len(done) > 0 {
		value = result(done)
	}
	if failures > 0 {
		return value, &plugins.ExitStatus{Code: 5}
	}
	return value, nil
}

// checkIDs is Bun's "No ... IDs provided" check on the arguments or stdin.
func checkIDs(argName, message string) func(plugins.CommandInput, plugins.FailFunc) error {
	return func(in plugins.CommandInput, fail plugins.FailFunc) error {
		if len(collectIDs(args(in, argName), in)) == 0 {
			return fail("INVALID_PARAMS", message, "Pass IDs as args or pipe via stdin")
		}
		return nil
	}
}

var chunkOptionSpecs = []plugins.OptionSpec{
	{Flags: "--chunk-size <n>", Description: "IDs per batchModify call (max 1000)", DefaultValue: "1000"},
	{Flags: "--max-retries <n>", Description: "Retries per chunk on 429/5xx", DefaultValue: "5"},
	{Flags: "--dry-run", Description: "Print chunk plan without calling the API"},
}

func archiveCmd() plugins.CommandSpec {
	check := checkIDs("message-id", "No message IDs provided")
	return plugins.CommandSpec{
		Path:         "archive",
		Description:  "Archive one or more messages (bulk-safe via batchModify)",
		Access:       "write",
		AccessFor:    plugins.WriteUnlessInvalid(check),
		NoProfileFor: dryRun,
		Operation:    "archive email",
		Input:        "text",
		Arguments:    []plugins.ArgumentSpec{{Name: "message-id", Description: "Message ID(s) (or pipe one-per-line via stdin)", Variadic: true}},
		Options:      chunkOptionSpecs,
		Examples: []string{
			"# archive one message",
			"agentio gmail archive 18c4f1a2b3d",
			"# archive several at once",
			"agentio gmail archive 18c4f1a2b3d 18c4f1a2b3e 18c4f1a2b3f",
			"# archive thousands by piping IDs from search (uses messages.batchModify, 1000/call)",
			`agentio gmail search --query "from:noreply@example.com older_than:1y" --limit 5000 --ids-only \`,
			"  | agentio gmail archive",
			"# preview the chunk plan without calling the API",
			`echo "id1 id2 id3" | agentio gmail archive --dry-run`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := check(in, run.Fail); err != nil {
				return nil, err
			}
			ids := collectIDs(args(in, "message-id"), in)
			chunkSize, maxRetries := chunkOptions(in)
			if in.Flag("dry-run") {
				return &dryRunPlan{Action: "archive", TotalIDs: len(ids), ChunkSize: chunkSize,
					Chunks: (len(ids) + chunkSize - 1) / chunkSize, AddLabels: []string{}, RemoveLabels: []string{"INBOX"}}, nil
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			if len(ids) == 1 {
				if err := a.archive(ids[0]); err != nil {
					return nil, err
				}
				return archived{ID: ids[0]}, nil
			}
			return batchOutcome(a.batchModify("archive", ids, nil, []string{"INBOX"}, chunkSize, maxRetries))
		},
		Format: render,
	}
}

// batchOutcome prints the summary, then exits 5 when a chunk failed.
func batchOutcome(result *batchResult) (any, error) {
	if len(result.Failed) > 0 {
		return result, &plugins.ExitStatus{Code: 5}
	}
	return result, nil
}

func checkMark(in plugins.CommandInput, fail plugins.FailFunc) error {
	read, unread := in.Flag("read"), in.Flag("unread")
	if !read && !unread {
		return fail("INVALID_PARAMS", "Specify --read or --unread", "")
	}
	if read && unread {
		return fail("INVALID_PARAMS", "Cannot specify both --read and --unread", "")
	}
	return nil
}

func markCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "mark",
		Description: "Mark one or more messages as read or unread",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(checkMark),
		Operation:   "mark email",
		Arguments:   []plugins.ArgumentSpec{{Name: "message-id", Description: "Message ID(s)", Required: true, Variadic: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--read", Description: "Mark as read"},
			{Flags: "--unread", Description: "Mark as unread"},
		},
		Examples: []string{
			"# mark one message as read",
			"agentio gmail mark 18c4f1a2b3d --read",
			"# mark several back to unread",
			"agentio gmail mark 18c4f1a2b3d 18c4f1a2b3e --unread",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := checkMark(in, run.Fail); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			read := in.Flag("read")
			var done markedList
			for _, id := range args(in, "message-id") {
				if err := a.mark(id, read); err != nil {
					// Bun printed each mark as it went, then threw.
					if len(done) == 0 {
						return nil, err
					}
					return done, err
				}
				done = append(done, marked{ID: id, Read: read})
			}
			return done, nil
		},
		Format: render,
	}
}

func labelsListCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "labels list",
		Description: "List all labels",
		Access:      "read",
		Examples: []string{
			"# list every label (system + user)",
			"agentio gmail labels list",
			"# list labels for a specific profile",
			"agentio gmail labels list --profile alice@example.com",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			labels, err := a.listLabels()
			if err != nil {
				return nil, err
			}
			return labelList(labels), nil
		},
		Format: render,
	}
}

func labelsCreateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "labels create",
		Description: "Create a new label",
		Access:      "write",
		Operation:   "create label",
		Arguments:   []plugins.ArgumentSpec{{Name: "name", Description: `Label name (use "/" for nesting, e.g. "auto/receipts")`, Required: true}},
		Examples: []string{
			"# create a top-level label",
			"agentio gmail labels create receipts",
			`# create a nested label (use "/" for hierarchy)`,
			"agentio gmail labels create auto/receipts",
			"# nested two levels deep",
			"agentio gmail labels create work/clients/acme",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			l, err := a.createLabel(in.Arg("name"))
			if err != nil {
				return nil, err
			}
			return (*labelCreated)(l), nil
		},
		Format: render,
	}
}

func labelsDeleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "labels delete",
		Description: "Delete a user label",
		Access:      "write",
		Operation:   "delete label",
		Arguments:   []plugins.ArgumentSpec{{Name: "name-or-id", Description: "Label name or ID", Required: true}},
		Examples: []string{
			"# delete a user label by name",
			"agentio gmail labels delete receipts",
			"# delete a nested label",
			"agentio gmail labels delete auto/receipts",
			"# delete by label ID",
			"agentio gmail labels delete Label_1234567890",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.deleteLabel(in.Arg("name-or-id")))
		},
		Format: render,
	}
}

func labelsRenameCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "labels rename",
		Description: "Rename a user label",
		Access:      "write",
		Operation:   "rename label",
		Arguments: []plugins.ArgumentSpec{
			{Name: "old", Description: "Existing label name or ID", Required: true},
			{Name: "new", Description: "New label name", Required: true},
		},
		Examples: []string{
			"# rename a label",
			"agentio gmail labels rename receipts invoices",
			"# move a label into a nested hierarchy",
			"agentio gmail labels rename receipts auto/receipts",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			l, err := a.renameLabel(in.Arg("old"), in.Arg("new"))
			if err != nil {
				return nil, err
			}
			return &labelRenamed{Old: in.Arg("old"), Label: *l}, nil
		},
		Format: render,
	}
}

func filtersListCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "filters list",
		Description: "List all filters",
		Access:      "read",
		Examples: []string{
			"# list every filter",
			"agentio gmail filters list",
			"# list filters for a specific profile",
			"agentio gmail filters list --profile alice@example.com",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			filters, err := a.listFilters()
			if err != nil {
				return nil, err
			}
			names, err := a.labelNamesByID()
			if err != nil {
				return nil, err
			}
			return &filterListing{filters: filters, names: names}, nil
		},
		Format: render,
	}
}

func filtersGetCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "filters get",
		Description: "Get a filter",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Filter ID", Required: true}},
		Examples: []string{
			"# show full filter details",
			"agentio gmail filters get ANe1BmgABCDEF1234567890",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			f, err := a.getFilter(in.Arg("id"))
			if err != nil {
				return nil, err
			}
			names, err := a.labelNamesByID()
			if err != nil {
				return nil, err
			}
			return &filterView{filter: *f, names: names}, nil
		},
		Format: render,
	}
}

// filterCriteriaFrom is Bun parseFilterCriteriaFromOptions.
func filterCriteriaFrom(in plugins.CommandInput, fail plugins.FailFunc) (filterCriteria, error) {
	c := filterCriteria{
		From: in.Option("from"), To: in.Option("to"), Subject: in.Option("subject"), Query: in.Option("query"),
		NegatedQuery: in.Option("negated-query"), HasAttachment: in.Flag("has-attachment"), ExcludeChats: in.Flag("exclude-chats"),
	}
	// Bun checks `!== undefined`: a given "" is set.
	sizeRaw, sizeGiven := in.LookupOption("size")
	comparison, comparisonGiven := in.LookupOption("size-comparison")
	if sizeGiven != comparisonGiven {
		return c, fail("INVALID_PARAMS", "--size and --size-comparison must be set together", "")
	}
	if sizeGiven {
		if comparison != "larger" && comparison != "smaller" {
			return c, fail("INVALID_PARAMS", `--size-comparison must be "larger" or "smaller"`, "")
		}
		size := jsvalue.ParseInt(sizeRaw)
		if math.IsNaN(size) || math.IsInf(size, 0) || size < 0 {
			return c, fail("INVALID_PARAMS", "--size must be a non-negative integer (bytes)", "")
		}
		n := int64(size)
		c.Size, c.SizeComparison = &n, comparison
	}
	return c, nil
}

func (c filterCriteria) empty() bool {
	return c == filterCriteria{}
}

// checkFilterCreate is the Bun filters create input checks, before its write check.
func checkFilterCreate(in plugins.CommandInput, fail plugins.FailFunc) error {
	c, err := filterCriteriaFrom(in, fail)
	if err != nil {
		return err
	}
	if c.empty() {
		return fail("INVALID_PARAMS", "At least one criterion is required",
			"Use --from, --to, --subject, --query, --negated-query, --has-attachment, --exclude-chats, or --size")
	}
	if len(in.List("apply")) == 0 && len(in.List("remove")) == 0 && in.Option("forward") == "" {
		return fail("INVALID_PARAMS", "At least one action is required", "Use --apply, --remove, or --forward")
	}
	return nil
}

func filtersCreateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "filters create",
		Description: "Create a Gmail filter",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(checkFilterCreate),
		Operation:   "create filter",
		Options: []plugins.OptionSpec{
			{Flags: "--from <email>", Description: "Match sender"},
			{Flags: "--to <email>", Description: "Match recipient"},
			{Flags: "--subject <text>", Description: "Match subject text"},
			{Flags: "--query <q>", Description: `Gmail search query (same syntax as "gmail search")`},
			{Flags: "--negated-query <q>", Description: "Gmail search query that must NOT match"},
			{Flags: "--has-attachment", Description: "Match only messages with attachments"},
			{Flags: "--exclude-chats", Description: "Exclude chat messages"},
			{Flags: "--size <bytes>", Description: "Match by message size (paired with --size-comparison)"},
			{Flags: "--size-comparison <cmp>", Description: "Size comparison: larger|smaller (paired with --size)"},
			{Flags: "--apply <label>", Description: "Label to apply (name or ID, repeatable)", Repeatable: true},
			{Flags: "--remove <label>", Description: "Label to remove (name or ID, repeatable)", Repeatable: true},
			{Flags: "--forward <email>", Description: "Forward to a verified forwarding address"},
		},
		Examples: []string{
			"# apply a label to mail from a sender",
			"agentio gmail filters create --from noreply@example.com --apply Receipts",
			"# archive newsletters automatically",
			"agentio gmail filters create --from news@example.com --remove INBOX",
			"# complex criteria + multiple actions",
			`agentio gmail filters create \`,
			`  --query "has:attachment subject:invoice" \`,
			"  --apply Auto/Invoices --remove INBOX",
			"# forward all mail from a sender (forwarding address must be verified in Gmail settings)",
			"agentio gmail filters create --from boss@example.com --forward archive@me.com",
			"# size-based filter (5MB or larger)",
			"agentio gmail filters create --size 5000000 --size-comparison larger --apply Large",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := checkFilterCreate(in, run.Fail); err != nil {
				return nil, err
			}
			criteria, _ := filterCriteriaFrom(in, run.Fail)
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			add, err := a.resolveLabelIDs(in.List("apply"))
			if err != nil {
				return nil, err
			}
			remove, err := a.resolveLabelIDs(in.List("remove"))
			if err != nil {
				return nil, err
			}
			action := filterAction{Forward: in.Option("forward")}
			if len(add) > 0 {
				action.AddLabelIDs = add
			}
			if len(remove) > 0 {
				action.RemoveLabelIDs = remove
			}
			f, err := a.createFilter(criteria, action)
			if err != nil {
				return nil, err
			}
			names, err := a.labelNamesByID()
			if err != nil {
				return nil, err
			}
			return &filterCreated{filter: *f, names: names}, nil
		},
		Format: render,
	}
}

func filtersDeleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "filters delete",
		Description: "Delete one or more filters",
		Access:      "write",
		Operation:   "delete filter",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Filter ID(s)", Required: true, Variadic: true}},
		Examples: []string{
			"# delete one filter",
			"agentio gmail filters delete ANe1BmgABCDEF1234567890",
			"# delete several at once",
			"agentio gmail filters delete ANe1Bmg... ANe1Bmh... ANe1Bmi...",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return eachID(args(in, "id"), a.deleteFilter,
				func(id string, err error) { run.Log(fmt.Sprintf("Failed to delete filter %s: %s", id, err.Error())) },
				func(ids []string) any { return filtersDeleted(ids) })
		},
		Format: render,
	}
}

func checkLabel(in plugins.CommandInput, fail plugins.FailFunc) error {
	if len(in.List("apply")) == 0 && len(in.List("remove")) == 0 {
		return fail("INVALID_PARAMS", "Specify at least one --apply or --remove", "")
	}
	return checkIDs("id", "No IDs provided")(in, fail)
}

func labelCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:         "label",
		Description:  "Apply and/or remove labels on messages or threads (bulk-safe via batchModify)",
		Access:       "write",
		AccessFor:    plugins.WriteUnlessInvalid(checkLabel),
		NoProfileFor: dryRun,
		Operation:    "modify labels",
		Input:        "text",
		Arguments:    []plugins.ArgumentSpec{{Name: "id", Description: "Message ID(s) (or thread ID(s) with --thread); pipe one-per-line via stdin", Variadic: true}},
		Options: append([]plugins.OptionSpec{
			{Flags: "--apply <name>", Description: "Label to apply (name or ID, repeatable)", Repeatable: true},
			{Flags: "--remove <name>", Description: "Label to remove (name or ID, repeatable)", Repeatable: true},
			{Flags: "--thread", Description: "Treat IDs as thread IDs (expands to messages for batching)"},
		}, chunkOptionSpecs...),
		Examples: []string{
			"# apply a label to one message",
			"agentio gmail label 18c4f1a2b3d --apply receipts",
			"# remove a label from several messages",
			"agentio gmail label 18c4f1a2b3d 18c4f1a2b3e --remove INBOX",
			"# archive (remove INBOX) and apply a label in one call",
			"agentio gmail label 18c4f1a2b3d --apply auto/receipts --remove INBOX",
			"# apply multiple labels to a thread",
			"agentio gmail label 18c4f1a2b3d --thread --apply important --apply work",
			"# bulk: pipe IDs from search and label them",
			`agentio gmail search --query "subject:invoice older_than:1y" --limit 5000 --ids-only \`,
			"  | agentio gmail label --apply Archive/Invoices --remove INBOX",
			"# preview the chunk plan without calling the API",
			`echo "id1 id2 id3" | agentio gmail label --apply receipts --dry-run`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := checkLabel(in, run.Fail); err != nil {
				return nil, err
			}
			apply, remove := in.List("apply"), in.List("remove")
			ids := collectIDs(args(in, "id"), in)
			isThread := in.Flag("thread")
			chunkSize, maxRetries := chunkOptions(in)
			if in.Flag("dry-run") {
				if isThread {
					run.Log(fmt.Sprintf("would expand %d thread(s) to messages; chunk count below assumes 1 message/thread", len(ids)))
				}
				return &dryRunPlan{Action: "label", TotalIDs: len(ids), ChunkSize: chunkSize,
					Chunks: max(1, (len(ids)+chunkSize-1)/chunkSize), AddLabels: apply, RemoveLabels: remove}, nil
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			add, err := a.resolveLabelIDs(apply)
			if err != nil {
				return nil, err
			}
			drop, err := a.resolveLabelIDs(remove)
			if err != nil {
				return nil, err
			}
			modifyOne := func(id string) (any, error) {
				if err := a.modifyLabels(id, add, drop); err != nil {
					return nil, err
				}
				return &labelModified{ID: id, Applied: apply, Removed: remove}, nil
			}
			if len(ids) == 1 && !isThread {
				return modifyOne(ids[0])
			}
			messageIDs := ids
			if isThread {
				if messageIDs, err = a.expandThreads(ids, maxRetries); err != nil {
					return nil, err
				}
				run.Log(fmt.Sprintf("expanded %d thread(s) to %d message(s)", len(ids), len(messageIDs)))
			}
			switch len(messageIDs) {
			case 0:
				return noMessages{}, nil
			case 1:
				return modifyOne(messageIDs[0])
			}
			return batchOutcome(a.batchModify("label", messageIDs, add, drop, chunkSize, maxRetries))
		},
		Format: render,
	}
}

func attachmentCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "attachment",
		Description: "Download attachments from a message",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "message-id", Description: "Message ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--name <filename>", Description: "Download specific attachment by filename (downloads all if not specified)"},
			{Flags: "--output <dir>", Description: "Output directory", DefaultValue: "."},
		},
		Examples: []string{
			"# download every attachment to the current directory",
			"agentio gmail attachment 18c4f1a2b3d",
			"# download all attachments to a specific folder",
			"agentio gmail attachment 18c4f1a2b3d --output ./downloads",
			"# download just one attachment by filename",
			"agentio gmail attachment 18c4f1a2b3d --name invoice.pdf --output ./downloads",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			results, err := a.allAttachments(in.Arg("message-id"))
			if err != nil {
				return nil, err
			}
			if len(results) == 0 {
				return noAttachments{}, nil
			}
			name := in.Option("name")
			var chosen []downloaded
			for _, r := range results {
				if name == "" || r.attachment.Filename == name {
					chosen = append(chosen, r)
				}
			}
			if len(chosen) == 0 {
				return nil, run.Fail("NOT_FOUND", "Attachment not found: "+name, "")
			}
			out := &downloads{Count: len(chosen), Files: []downloadedFile{}}
			for _, r := range chosen {
				path := filepath.Join(in.Option("output"), r.attachment.Filename)
				if err := writeFile(path, r.data); err != nil {
					return out, err
				}
				out.Files = append(out.Files, downloadedFile{Filename: r.attachment.Filename, Path: path, Size: len(r.data)})
			}
			return out, nil
		},
		Format: render,
	}
}

func exportCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "export",
		Description: "Export a message as PDF",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "message-id", Description: "Message ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--output <path>", Description: "Output file path", DefaultValue: "message.pdf"},
		},
		Examples: []string{
			"# export to default message.pdf in CWD",
			"agentio gmail export 18c4f1a2b3d",
			"# export to a specific path",
			"agentio gmail export 18c4f1a2b3d --output ./archive/invoice.pdf",
			"",
			"Requires Chrome, Chromium, or Microsoft Edge installed locally.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			m, err := a.get(in.Arg("message-id"), "html")
			if err != nil {
				return nil, err
			}
			output := in.Option("output")
			if err := exportPDF(m, output, run); err != nil {
				return nil, err
			}
			return exported{Output: output}, nil
		},
		Format: render,
	}
}

// exportPath is Bun's absolute output: kept when it starts with "/", else
// joined to the working directory.
func exportPath(output string) string {
	if strings.HasPrefix(output, "/") {
		return output
	}
	cwd, _ := os.Getwd()
	return filepath.Join(cwd, output)
}

// chromeCandidates is Bun findChromePath's list for this platform.
func chromeCandidates() []string {
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		}
	case "linux":
		return []string{
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			"/usr/bin/microsoft-edge",
			"/usr/bin/brave-browser",
		}
	case "windows":
		programFiles := cmp.Or(os.Getenv("PROGRAMFILES"), `C:\Program Files`)
		programFilesX86 := cmp.Or(os.Getenv("PROGRAMFILES(X86)"), `C:\Program Files (x86)`)
		localAppData := os.Getenv("LOCALAPPDATA")
		return []string{
			programFiles + `\Google\Chrome\Application\chrome.exe`,
			programFilesX86 + `\Google\Chrome\Application\chrome.exe`,
			localAppData + `\Google\Chrome\Application\chrome.exe`,
			programFiles + `\Microsoft\Edge\Application\msedge.exe`,
			programFilesX86 + `\Microsoft\Edge\Application\msedge.exe`,
			programFiles + `\BraveSoftware\Brave-Browser\Application\brave.exe`,
			localAppData + `\BraveSoftware\Brave-Browser\Application\brave.exe`,
		}
	}
	return nil
}

// findChrome is Bun findChromePath: the first candidate with a size.
var findChrome = func() string {
	for _, p := range chromeCandidates() {
		if info, err := os.Stat(p); err == nil && info.Size() > 0 {
			return p
		}
	}
	return ""
}

// runChrome is Bun.spawnSync: the exit code and stderr of the finished process.
var runChrome = func(path string, argv []string) (int, string, error) {
	cmd := osexec.Command(path, argv...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	var exit *osexec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), stderr.String(), nil
	}
	if err != nil {
		return 0, "", err
	}
	return 0, stderr.String(), nil
}

// escapeHTML is Bun escapeHtml: &, <, > and ".
var escapeHTML = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace

var bodyTag = regexp.MustCompile(`(?i)<body[^>]*>`)

// exportHTML is the document Bun's export prints: a header block injected
// after <body> of a full document, or a minimal page around a fragment.
func exportHTML(m *message) string {
	header := `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px 20px; margin-bottom: 16px; border-bottom: 1px solid #ddd; background: #f9f9f9;">
  <div style="font-size: 1.3em; font-weight: 600; margin-bottom: 12px;">` + escapeHTML(m.Subject) + `</div>
  <div style="margin: 4px 0; font-size: 0.9em;"><strong>From:</strong> ` + escapeHTML(m.From) + `</div>
  <div style="margin: 4px 0; font-size: 0.9em;"><strong>To:</strong> ` + escapeHTML(strings.Join(m.To, ", ")) + `</div>
  <div style="margin: 4px 0; font-size: 0.9em;"><strong>Date:</strong> ` + escapeHTML(m.Date) + `</div>
</div>`
	body := ""
	if m.Body != nil {
		body = *m.Body
	}
	start := strings.ToLower(jsvalue.Trim(body))
	if strings.HasPrefix(start, "<!doctype") || strings.HasPrefix(start, "<html") {
		if loc := bodyTag.FindStringIndex(body); loc != nil {
			return body[:loc[1]] + header + body[loc[1]:]
		}
		return body
	}
	return "<!DOCTYPE html>\n<html>\n<head><meta charset=\"utf-8\"></head>\n<body>\n" + header +
		"\n<div style=\"padding: 0 20px;\">" + body + "</div>\n</body>\n</html>"
}

// exportPDF is the rest of Bun's export: headless Chrome prints a temporary
// HTML file to the output path, and the file is removed either way.
func exportPDF(m *message, output string, run *plugins.RunContext) error {
	html := exportHTML(m)
	chrome := findChrome()
	if chrome == "" {
		return run.Fail("NOT_FOUND", "Chrome/Chromium not found", "Install Google Chrome, Chromium, or Microsoft Edge")
	}
	temp := filepath.Join(os.TempDir(), fmt.Sprintf("agentio-email-%d.html", now().UnixMilli()))
	if err := writeFile(temp, []byte(html)); err != nil {
		return err
	}
	defer os.Remove(temp)
	run.Log("Generating PDF...")
	code, stderr, err := runChrome(chrome, []string{
		"--headless=new", "--disable-gpu", "--no-pdf-header-footer", "--print-to-pdf=" + exportPath(output), temp,
	})
	if err != nil {
		return err
	}
	if code != 0 {
		return run.Fail("API_ERROR", "Chrome failed: "+stderr, "")
	}
	return nil
}
