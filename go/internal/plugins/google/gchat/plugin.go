// Package gchat is the Google Chat service. A webhook profile posts to one
// space; an OAuth profile uses the Chat API, and the People API for names.
package gchat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "gchat",
		DisplayName: "Google Chat",
		Description: "Use when interacting with Google Chat via the agentio CLI - send messages, list spaces, read history.",
		Profile: &plugins.ProfileSpec{
			Setup:          setup,
			Validate:       validate,
			Reauthenticate: reauthenticate,
			// A webhook profile has no refreshToken, so Applies leaves it alone.
			Refresh:  google.Camel.RefreshSpec(),
			ListInfo: listInfo,
		},
		Commands: []plugins.CommandSpec{
			sendCmd(), listCmd(), getCmd(), spacesCmd(), membersCmd(), userCmd(), directoryRefreshCmd(),
		},
	}
}

func isWebhook(creds map[string]any) bool {
	return creds["type"] == "webhook"
}

func listInfo(creds map[string]any) string {
	if isWebhook(creds) {
		return " - webhook"
	}
	return " - oauth"
}

func setup(ctx context.Context, opts plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("\nGoogle Chat Setup\n")
	kind, err := chooseType(setup)
	if err != nil {
		return nil, err
	}
	if kind == "webhook" {
		return setupWebhook(ctx, opts.Profile, setup)
	}
	return setupOAuth(ctx, setup)
}

// chooseType is Bun's interactiveSelect, asked as a numbered prompt as the
// confluence site choice is.
func chooseType(setup *plugins.SetupContext) (string, error) {
	answer, err := setup.Prompt("Choose profile type:\n  1) Webhook — Simple incoming webhook URL\n  2) OAuth — Full API access with Google Workspace account", false)
	answer = strings.ToLower(strings.TrimSpace(answer))
	if err != nil || answer == "" {
		return "", setup.Fail("INVALID_PARAMS", "Interactive input required but not running in terminal", "Run this command in an interactive terminal")
	}
	switch answer {
	case "1", "webhook":
		return "webhook", nil
	case "2", "oauth":
		return "oauth", nil
	}
	return "", setup.Fail("INVALID_PARAMS", fmt.Sprintf("Unknown profile type %q", answer), "Choose one of the listed types")
}

func setupWebhook(ctx context.Context, suggested string, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("Webhook Setup\n")
	setup.Log("1. In Google Chat, find or create a space")
	setup.Log("2. Go to Space Settings → Webhooks")
	setup.Log("3. Create a new webhook and copy the URL\n")
	webhookURL, _ := setup.Prompt("? Paste your webhook URL: ", false)
	webhookURL = strings.TrimSpace(webhookURL)
	if webhookURL == "" {
		return nil, setup.Fail("INVALID_PARAMS", "Webhook URL is required", "")
	}
	resp, err := postJSON(ctx, setup.Fetch, webhookURL, map[string]any{"text": "Test message from agentio"})
	if err != nil {
		return nil, setup.Fail("API_ERROR", "Failed to validate webhook: "+err.Error(), "Check that the URL is correct and accessible")
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, setup.Fail("API_ERROR", "Webhook validation failed: "+strconv.Itoa(resp.StatusCode), "Check the webhook URL and try again")
	}
	if suggested == "" {
		suggested = "webhook"
	}
	return &plugins.SetupResult{
		Credentials:          map[string]any{"type": "webhook", "webhookUrl": webhookURL},
		SuggestedProfileName: suggested,
		Info:                 "Webhook profile\nTest with: agentio gchat send \"Hello from agentio\"",
	}, nil
}

func setupOAuth(ctx context.Context, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("OAuth Setup\n")
	setup.Log("Starting OAuth flow for Google Chat profile...\n")
	tokens, err := google.PerformOAuth(ctx, setup, "gchat")
	if err != nil {
		return nil, err
	}
	email, err := google.FetchUserEmail(ctx, setup.Fetch, tokens.AccessToken)
	if err != nil {
		return nil, google.EmailFailure(setup, err)
	}
	creds := google.Camel.Merge(map[string]any{"type": "oauth"}, tokens)
	creds["email"] = email
	// The token must work with the Chat API, which needs a Workspace account.
	svc, err := chatService(ctx, &plugins.RunContext{Credentials: creds, Fetch: setup.Fetch})
	if err == nil {
		_, err = svc.Spaces.List().PageSize(1).Context(ctx).Do()
	}
	if err != nil {
		return nil, setup.Fail("AUTH_FAILED", "Failed to validate Google Chat access: "+google.Message(err),
			"Google Chat API requires a Google Workspace account. Personal Gmail accounts cannot use the Chat API.")
	}
	return &plugins.SetupResult{
		Credentials:          creds,
		SuggestedProfileName: email,
		Info:                 fmt.Sprintf("OAuth profile (%s)\nTest with: agentio gchat send \"Hello from agentio\"", email),
	}, nil
}

// reauthenticate skips a webhook profile (it does not expire) and otherwise
// is the shared camelCase reauthentication, marked as an OAuth profile.
func reauthenticate(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
	if isWebhook(creds) {
		setup.Log(fmt.Sprintf("\nSkipping gchat / %s: webhook profiles don't expire. Run 'agentio gchat profile add' to update.", profileName))
		return creds, nil
	}
	out, err := google.Reauthenticate("gchat", google.Camel)(ctx, creds, profileName, setup)
	if err != nil {
		return nil, err
	}
	out["type"] = "oauth"
	return out, nil
}

// validate is GChatClient.validate: a webhook cannot be checked without
// posting, an OAuth profile lists one space.
func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	if isWebhook(run.Credentials) {
		return plugins.ValidationResult{Valid: true, Info: "webhook"}, nil
	}
	svc, err := chatService(ctx, run)
	if err == nil {
		_, err = svc.Spaces.List().PageSize(1).Context(ctx).Do()
	}
	if err != nil {
		return google.ValidationFailure(err), nil
	}
	info, _ := run.Credentials["email"].(string)
	if info == "" {
		info = "oauth"
	}
	return plugins.ValidationResult{Valid: true, Info: info}, nil
}

// postJSON is Bun `fetch(url, { method: 'POST', body: JSON.stringify(body) })`.
func postJSON(ctx context.Context, fetch func(context.Context, *http.Request) (*http.Response, error), target string, body any) (*http.Response, error) {
	raw, err := stringify(body, "")
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return fetch(ctx, req)
}

// stringify is JSON.stringify(v, null, indent): no HTML escaping.
func stringify(v any, indent string) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", indent)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// textOrJSON is Bun's `--format <format>` check.
func textOrJSON(in plugins.CommandInput, run *plugins.RunContext) (bool, error) {
	switch format := in.Option("format"); format {
	case "text":
		return false, nil
	case "json":
		return true, nil
	default:
		return false, run.Fail("INVALID_PARAMS", "Unknown format: "+format, "Use --format text or --format json")
	}
}

func sendCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "send",
		Description: "Send a message to Google Chat",
		Access:      "write",
		Operation:   "send message",
		Input:       "text",
		Arguments:   []plugins.ArgumentSpec{{Name: "message", Description: "Message text (or pipe via stdin)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--space <id>", Description: "Space ID (required for OAuth profiles)"},
			{Flags: "--thread <id>", Description: "Thread ID (optional)"},
			{Flags: "--json [file]", Description: "Send rich message from JSON file (or stdin if no file specified)"},
			{Flags: "--attachment <path>", Description: "File to attach (repeatable, OAuth profiles only)", Repeatable: true},
		},
		Examples: []string{
			"# webhook profile: short text, no --space needed",
			`agentio gchat send "Deployment complete"`,
			"# OAuth profile: send to a specific space",
			`agentio gchat send "Status update" --space spaces/AAAA1234`,
			"# reply within an existing thread",
			`agentio gchat send "Following up" --space spaces/AAAA1234 --thread spaces/AAAA1234/threads/abcDEF`,
			"# rich card via JSON file (OAuth or webhook)",
			"agentio gchat send --json ./card.json --space spaces/AAAA1234",
			"# JSON via stdin (good for inline cards)",
			`echo '{"text":"Build status","cards":[{"header":{"title":"CI"}}]}' | \`,
			"  agentio gchat send --json --space spaces/AAAA1234",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			o := sendOptions{spaceID: in.Option("space"), attachments: in.List("attachment")}
			text := in.Arg("message")
			if source, ok := in.Options["json"]; ok && source != nil {
				if text != "" {
					return nil, run.Fail("INVALID_PARAMS", "Cannot use both text message and --json option",
						"Use either: agentio gchat send \"text\" OR agentio gchat send --json file.json")
				}
				payload, err := readPayload(source, in, run)
				if err != nil {
					return nil, err
				}
				o.payload = payload
			} else {
				if text == "" {
					text = google.Stdin(in)
				}
				if text == "" && len(o.attachments) == 0 {
					return nil, run.Fail("INVALID_PARAMS", "Message or --attachment is required. Provide as argument, pipe via stdin, or attach a file.", "")
				}
			}
			// Unescape shell-escaped characters (zsh history expansion: \! → !).
			o.text = strings.ReplaceAll(text, `\!`, "!")
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.send(o))
		},
		Format: formatSendResult,
	}
}

// readPayload is the --json branch: a file when --json has a value, stdin
// otherwise, parsed as JSON.
func readPayload(source any, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	var raw []byte
	if file, ok := source.(string); ok {
		content, err := os.ReadFile(file)
		if err != nil {
			return nil, run.Fail("INVALID_PARAMS", "Failed to read JSON file: "+file, "Check that the file exists and is readable")
		}
		raw = content
	} else {
		text := google.Stdin(in)
		if text == "" {
			return nil, run.Fail("INVALID_PARAMS", "No JSON provided via stdin", "Pipe JSON content: cat message.json | agentio gchat send --json")
		}
		raw = []byte(text)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var payload any
	err := dec.Decode(&payload)
	if err == nil && dec.More() {
		err = fmt.Errorf("invalid character after top-level value")
	}
	if err != nil {
		return nil, run.Fail("INVALID_PARAMS", "Invalid JSON: "+err.Error(), "Check that the JSON is valid")
	}
	return payload, nil
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List messages from a Google Chat space (OAuth profiles only)",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--space <id>", Description: "Space ID"},
			{Flags: "--limit <n>", Description: "Number of messages", DefaultValue: "10"},
			{Flags: "--thread <id>", Description: "Filter by thread ID"},
			{Flags: "--since <date>", Description: "Only messages after this date (YYYY-MM-DD)"},
			{Flags: "--until <date>", Description: "Only messages before this date (YYYY-MM-DD)"},
			{Flags: "--format <format>", Description: "Output format: text or json", DefaultValue: "text"},
		},
		Examples: []string{
			"# 10 most recent messages in a space (OAuth only)",
			"agentio gchat list --space spaces/AAAA1234",
			"# last 50 messages",
			"agentio gchat list --space spaces/AAAA1234 --limit 50",
			"# only messages in a specific thread",
			"agentio gchat list --space spaces/AAAA1234 --thread spaces/AAAA1234/threads/abcDEF",
			"# messages within a closed date range, as JSON for scripting",
			"agentio gchat list --space spaces/AAAA1234 --since 2026-04-01 --until 2026-05-01 --limit 5000 --format json",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := google.RequireOptions(in, run.Fail, "--space <id>"); err != nil {
				return nil, err
			}
			asJSON, err := textOrJSON(in, run)
			if err != nil {
				return nil, err
			}
			limit := jsvalue.ParseInt(in.Option("limit"))
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			messages, truncated, err := a.list(listOptions{
				spaceID: in.Option("space"), limit: limit, threadID: in.Option("thread"),
				since: in.Option("since"), until: in.Option("until"),
			})
			if err != nil {
				return nil, err
			}
			if truncated {
				oldest := "undefined"
				if len(messages) > 0 {
					oldest = messages[len(messages)-1].CreateTime
				}
				run.Log(fmt.Sprintf("Warning: reached --limit %s; more messages exist before %s. Raise --limit or narrow the window with --since/--until.",
					jsvalue.NumberString(limit), oldest))
			}
			return shown[[]message]{Value: messages, JSON: asJSON}, nil
		},
		Format: formatMessageList,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get a message from a Google Chat space (OAuth profiles only)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "message-id", Description: "Message ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--space <id>", Description: "Space ID"},
			{Flags: "--format <format>", Description: "Output format: text or json", DefaultValue: "text"},
		},
		Examples: []string{
			"# fetch one message by id from a space (OAuth only)",
			"agentio gchat get spaces/AAAA1234/messages/9876543210 --space spaces/AAAA1234",
			"# as JSON for scripting",
			"agentio gchat get spaces/AAAA1234/messages/9876543210 --space spaces/AAAA1234 --format json",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := google.RequireOptions(in, run.Fail, "--space <id>"); err != nil {
				return nil, err
			}
			asJSON, err := textOrJSON(in, run)
			if err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			msg, err := a.get(in.Option("space"), in.Arg("message-id"))
			if err != nil {
				return nil, err
			}
			return shown[*message]{Value: msg, JSON: asJSON}, nil
		},
		Format: formatMessage,
	}
}

func spacesCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "spaces",
		Description: "List available Google Chat spaces (OAuth profiles only)",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--filter <text>", Description: "Filter spaces by name (case-insensitive)"},
			{Flags: "--with <user>", Description: "Resolve the 1:1 DM space with a user (email, numeric id, or users/<id>)"},
		},
		Examples: []string{
			"# all spaces this OAuth profile can see",
			"agentio gchat spaces",
			"# filter by display name (case-insensitive substring)",
			"agentio gchat spaces --filter eng",
			"# resolve the 1:1 DM space with a workspace user (1 API call, instant)",
			"agentio gchat spaces --with teammate@example.com",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			if with := in.Option("with"); with != "" {
				dm, err := a.findDirectMessage(with)
				if err != nil {
					return nil, err
				}
				return []space{*dm}, nil
			}
			spaces, err := a.listSpaces()
			if err != nil {
				return nil, err
			}
			if filter := strings.ToLower(in.Option("filter")); filter != "" {
				kept := []space{}
				for _, s := range spaces {
					if strings.Contains(strings.ToLower(s.DisplayName), filter) {
						kept = append(kept, s)
					}
				}
				spaces = kept
			}
			return spaces, nil
		},
		Format: formatSpaces,
	}
}

func membersCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "members",
		Description: "List members of a Google Chat space (OAuth profiles only)",
		Access:      "read",
		Options:     []plugins.OptionSpec{{Flags: "--space <id-or-name>", Description: "Space ID or display name"}},
		Examples: []string{
			"# members by space id",
			"agentio gchat members --space spaces/AAAA1234",
			"# members by space display name (resolved against the space list)",
			`agentio gchat members --space "Engineering"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := google.RequireOptions(in, run.Fail, "--space <id-or-name>"); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.listMembers(in.Option("space")))
		},
		Format: formatMembers,
	}
}

func userCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "user",
		Description: "Get full user info from the People API (OAuth profiles only)",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "user-id", Description: `User ID (e.g. "123456789" or "users/123456789")`, Required: true}},
		Examples: []string{
			"# by raw numeric id",
			"agentio gchat user 123456789",
			"# by full users/<id> form (as it appears in 'gchat members' output)",
			"agentio gchat user users/123456789",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.getUser(in.Arg("user-id")))
		},
		Format: formatUser,
	}
}

func directoryRefreshCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "directory refresh",
		Description: "Force refresh the cached workspace directory (OAuth profiles only)",
		Access:      "read",
		Examples: []string{
			"# rebuild the local user-id -> name/email cache (OAuth only)",
			"agentio gchat directory refresh",
			"# refresh the cache for a specific OAuth profile",
			"agentio gchat directory refresh --profile alice@example.com",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return google.Result(a.refreshDirectory())
		},
		Format: formatDirectoryRefresh,
	}
}
