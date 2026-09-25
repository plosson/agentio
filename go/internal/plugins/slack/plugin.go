// Package slack is the Slack service: a webhook profile posts a text message
// or a Block Kit payload to the channel the incoming webhook was made for.
package slack

import (
	"context"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:         plugins.APIVersion,
		ID:                 "slack",
		DisplayName:        "Slack",
		Description:        "Use when sending Slack messages via the agentio CLI.",
		CommandDescription: "Slack operations",
		Profile: &plugins.ProfileSpec{
			AddDescription:     "Add a new Slack profile (webhook)",
			ProfileDescription: "Profile name (required)",
			Setup:              setup,
			Validate:           validate,
			// A webhook URL does not expire: no refresh lifecycle, and the hub
			// serves the whole credential map.
			ListInfo:       listInfo,
			RequireProfile: true,
		},
		Commands: []plugins.CommandSpec{sendCmd()},
	}
}

// channel is `credentials.channelName` when truthy, as Bun interpolates it.
func channel(creds plugins.Credentials) (string, bool) {
	name := creds.Value("channelName")
	if !jsvalue.Truthy(name) {
		return "", false
	}
	return jsvalue.String(name), true
}

// listInfo is Bun getExtraInfo.
func listInfo(creds plugins.Credentials) string {
	if name, ok := channel(creds); ok {
		return " - #" + name
	}
	return " - webhook"
}

// validate is SlackClient.validate: a webhook cannot be checked without posting.
func validate(_ context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	info := "webhook"
	if name, ok := channel(run.Credentials); ok {
		info = "#" + name
	}
	return plugins.ValidationResult{Valid: true, Info: info}, nil
}

// setup is slackProfileAdd: the webhook URL is checked by posting a test
// message before the profile is saved.
func setup(ctx context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("\nSlack Webhook Setup\n")
	setup.Log("1. Go to https://api.slack.com/apps and create a new app (or use existing)")
	setup.Log("2. Enable \"Incoming Webhooks\" in Features")
	setup.Log("3. Click \"Add New Webhook to Workspace\" and select a channel")
	setup.Log("4. Copy the Webhook URL\n")

	webhookURL := ask(setup, "? Paste your webhook URL: ")
	if webhookURL == "" {
		return nil, setup.Fail("INVALID_PARAMS", "Webhook URL is required", "")
	}
	if !strings.HasPrefix(webhookURL, "https://hooks.slack.com/") {
		return nil, setup.Fail("INVALID_PARAMS", "Invalid Slack webhook URL", "URL should start with https://hooks.slack.com/")
	}
	status, body, err := postJSON(ctx, setup.Fetch, webhookURL, textBody("Test message from agentio"))
	if err != nil {
		return nil, setup.Fail("API_ERROR", "Failed to validate webhook: "+err.Error(), "Check that the URL is correct and accessible")
	}
	if !ok(status) {
		return nil, setup.Fail("API_ERROR", "Webhook validation failed: "+statusText(status, body), "Check the webhook URL and try again")
	}

	channelName := ask(setup, "? Channel name (optional, for display): ")
	// Bun: `{ type: 'webhook', webhookUrl, channelName: channelName || undefined }`.
	creds := jsvalue.ObjectOf("type", "webhook", "webhookUrl", webhookURL, "channelName", jsvalue.Undefined)
	suggested := "webhook"
	if channelName != "" {
		creds.Set("channelName", channelName)
		suggested = channelName
	}
	return &plugins.SetupResult{
		Credentials:          creds,
		SuggestedProfileName: suggested,
		Info:                 `Test with: agentio slack send "Hello from agentio"`,
	}, nil
}

// ask is Bun prompt(): the answer trimmed; no answer is "".
func ask(setup *plugins.SetupContext, question string) string {
	answer, _ := setup.Prompt(question, false)
	return jsvalue.Trim(answer)
}

func sendCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "send",
		Description: "Send a message to Slack",
		Access:      "write",
		Prepare:     plugins.Parse(readMessage),
		Operation:   "send message",
		Input:       "text",
		Arguments:   []plugins.ArgumentSpec{{Name: "message", Description: "Message text (or pipe via stdin)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--json [file]", Description: "Send Block Kit message from JSON file (or stdin if no file specified)"},
		},
		Examples: []string{
			"# send a quick text message to the default profile",
			`agentio slack send "deploy finished"`,
			"# pipe message body via stdin",
			`echo "build failed: see logs" | agentio slack send`,
			"# send a Block Kit payload from a JSON file",
			"agentio slack send --json ./alert.json",
			"# send to a specific profile",
			`agentio slack send --profile alerts "incident opened"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return plugins.Result(send(ctx, run, plugins.Prepared[message](run)))
		},
		Format: formatSendResult,
	}
}

// message is Bun SlackSendOptions: a text, or a parsed --json payload.
type message struct {
	text      string
	payload   any
	isPayload bool
}

// readMessage is the send action's input handling before getSlackClient, in
// Bun's order: --json
// reads a file (or stdin when bare) and parses it; otherwise the argument, or
// stdin, is the text.
func readMessage(in plugins.CommandInput, fail plugins.FailFunc) (message, error) {
	text := in.Arg("message")
	source, given := in.Options["json"]
	if !given || source == nil {
		if text == "" {
			text = plugins.Stdin(in)
		}
		if text == "" {
			return message{}, fail("INVALID_PARAMS", "Message is required. Provide as argument or pipe via stdin.", "")
		}
		return message{text: text}, nil
	}
	if text != "" {
		return message{}, fail("INVALID_PARAMS", "Cannot use both text message and --json option",
			`Use either: agentio slack send "text" OR agentio slack send --json file.json`)
	}
	payload, err := plugins.JSONPayload(in, source, fail, "Pipe JSON content: cat message.json | agentio slack send --json")
	if err != nil {
		return message{}, err
	}
	return message{payload: payload, isPayload: true}, nil
}
