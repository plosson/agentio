// Package discourse is the Discourse service.
package discourse

import (
	"context"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:         plugins.APIVersion,
		ID:                 "discourse",
		DisplayName:        "Discourse",
		Description:        "Use when interacting with Discourse forums via the agentio CLI.",
		CommandDescription: "Discourse forum operations",
		Profile: &plugins.ProfileSpec{
			ProfileDescription: "Profile name (auto-detected from username if not provided)",
			Setup:              setup,
			Validate:           validate,
			ListInfo:           listInfo,
		},
		Commands: []plugins.CommandSpec{listCmd(), getCmd(), categoriesCmd()},
	}
}

func listInfo(creds map[string]any) string {
	if base := str(creds, "baseUrl"); base != "" {
		return " - " + base
	}
	return ""
}

// failed turns a client error into the host error Bun's handleError prints.
func failed(run *plugins.RunContext, err error) error {
	if ae, ok := err.(*apiError); ok {
		return run.Fail(ae.code, ae.message, "")
	}
	return err
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List latest topics",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--category <slug>", Description: "Filter by category slug or name"},
			{Flags: "--page <number>", Description: "Page number (0-indexed)", DefaultValue: "0"},
		},
		Examples: []string{
			"# latest topics on the default profile",
			"agentio discourse list",
			"# second page of topics in a specific category",
			"agentio discourse list --category support --page 1",
			"# latest topics on a named profile",
			"agentio discourse list --profile meta",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			page, _ := jsParseInt(in.Option("page")) // NaN > 0 is false: no page
			topics, err := newAPI(ctx, run.Credentials, run.Fetch).listTopics(in.Option("category"), page)
			if err != nil {
				return nil, failed(run, err)
			}
			return topics, nil
		},
		Format: formatTopics,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get a topic with its posts",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "topic-id", Description: "Topic ID", Required: true}},
		Examples: []string{
			"# get a topic and its posts by numeric ID",
			"agentio discourse get 12345",
			"# use a named profile",
			"agentio discourse get 12345 --profile meta",
		},
		Prepare: plugins.Parse(topicID),
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			detail, err := newAPI(ctx, run.Credentials, run.Fetch).getTopic(plugins.Prepared[int](run))
			if err != nil {
				return nil, failed(run, err)
			}
			return detail, topicError(detail)
		},
		Format: formatTopic,
	}
}

// topicID is get's <topic-id>, checked before the client as in Bun.
func topicID(in plugins.CommandInput, fail plugins.FailFunc) (int, error) {
	id, ok := jsParseInt(in.Arg("topic-id"))
	if !ok {
		return 0, fail("INVALID_PARAMS", "Topic ID must be a number", "")
	}
	return id, nil
}

func categoriesCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "categories",
		Description: "List all categories",
		Access:      "read",
		Examples: []string{
			"# list all visible categories",
			"agentio discourse categories",
			"# categories on a named forum profile",
			"agentio discourse categories --profile meta",
		},
		Run: func(ctx context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
			cats, err := newAPI(ctx, run.Credentials, run.Fetch).getCategories()
			if err != nil {
				return nil, failed(run, err)
			}
			return cats, nil
		},
		Format: formatCategories,
	}
}

// ask is Bun's prompt(): the answer String#trim'd. A closed stdin reads as
// empty, so the caller's "is required" check reports it.
func ask(setup *plugins.SetupContext, question string) string {
	answer, _ := setup.Prompt(question, false)
	return jsvalue.Trim(answer)
}

func setup(ctx context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("\nDiscourse Setup\n")

	setup.Log("Step 1: Enter your Discourse forum URL")
	setup.Log("  Example: https://meta.discourse.org or https://forum.example.com\n")
	baseURL := ask(setup, "? Forum URL: ")
	if baseURL == "" {
		return nil, setup.Fail("INVALID_PARAMS", "Forum URL is required", "")
	}
	normalized := baseURL
	if !strings.HasPrefix(normalized, "http://") && !strings.HasPrefix(normalized, "https://") {
		normalized = "https://" + normalized
	}
	normalized = strings.TrimSuffix(normalized, "/")

	setup.Log("\nStep 2: Create an API key")
	setup.Log("  1. Go to your Discourse admin panel")
	setup.Log(fmt.Sprintf("     %s/admin/api/keys", normalized))
	setup.Log(`  2. Click "New API Key"`)
	setup.Log(`  3. Description: "agentio CLI"`)
	setup.Log(`  4. User Level: Choose your user or "All Users" for admin access`)
	setup.Log(`  5. Scope: "Read" (or "Read, Write" if you plan to create topics later)`)
	setup.Log(`  6. Click "Save" and copy the API key` + "\n")
	apiKey := ask(setup, "? API Key: ")
	if apiKey == "" {
		return nil, setup.Fail("INVALID_PARAMS", "API key is required", "")
	}

	setup.Log("\nStep 3: Enter your Discourse username")
	setup.Log("  This should match the user associated with the API key\n")
	username := ask(setup, "? Username: ")
	if username == "" {
		return nil, setup.Fail("INVALID_PARAMS", "Username is required", "")
	}

	setup.Log("\nValidating credentials...")
	creds := map[string]any{"baseUrl": normalized, "apiKey": apiKey, "username": username}
	if _, err := newAPI(ctx, creds, setup.Fetch).getCategories(); err != nil {
		ae, ok := err.(*apiError)
		if !ok {
			return nil, err
		}
		switch ae.code {
		case "AUTH_FAILED":
			return nil, setup.Fail("AUTH_FAILED", "Invalid API key or username. Please check your credentials.", "Make sure the API key is active and the username matches")
		case "NETWORK_ERROR":
			return nil, setup.Fail("NETWORK_ERROR", "Cannot connect to "+normalized, "Check the URL and your network connection")
		}
		return nil, setup.Fail(ae.code, ae.message, "")
	}

	setup.Log("\nConnected to " + normalized)
	setup.Log("Authenticated as " + username + "\n")
	return &plugins.SetupResult{
		Credentials:          creds,
		SuggestedProfileName: username,
		Info:                 "Test with: agentio discourse list",
	}, nil
}
