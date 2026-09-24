// Package board is a fake static-token service. It has credentials and a
// write gate, and no refresh lifecycle, so the hub hands the token over whole.
package board

import (
	"context"

	"github.com/plosson/agentio/go/internal/plugin"
)

const ServiceID = "board"

func New() *plugin.Plugin {
	return &plugin.Plugin{
		APIVersion:  plugin.APIVersion,
		ID:          ServiceID,
		DisplayName: "Board",
		Description: "Fake static-token service with no refresh lifecycle",
		Profile: &plugin.ProfileSpec{
			Setup:    setup,
			Validate: validate,
		},
		Commands: []plugin.CommandSpec{cardsList(), cardsCreate()},
	}
}

func setup(_ context.Context, _ plugin.SetupOptions, setup *plugin.SetupContext) (*plugin.SetupResult, error) {
	token, err := setup.Prompt("API token", true)
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, setup.Fail("INVALID_PARAMS", "API token is required", "")
	}
	workspace, err := setup.Prompt("Workspace", false)
	if err != nil {
		return nil, err
	}
	if workspace == "" {
		workspace = "default"
	}
	return &plugin.SetupResult{
		Credentials:          map[string]any{"token": token, "workspace": workspace},
		SuggestedProfileName: workspace,
		Info:                 "Workspace: " + workspace,
	}, nil
}

func validate(_ context.Context, run *plugin.RunContext) (plugin.ValidationResult, error) {
	token, _ := run.Credentials["token"].(string)
	workspace, _ := run.Credentials["workspace"].(string)
	if token == "" || token == "expired" {
		return plugin.ValidationResult{Valid: false, Error: "token rejected"}, nil
	}
	return plugin.ValidationResult{Valid: true, Info: "Workspace: " + workspace}, nil
}

func cardsList() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "cards list", Description: "List cards in the workspace",
		Access: "read", Examples: []string{"agentio board cards list"},
		Run: func(_ context.Context, _ plugin.CommandInput, run *plugin.RunContext) (any, error) {
			return map[string]any{"workspace": run.Credentials["workspace"], "cards": []string{}}, nil
		},
	}
}

func cardsCreate() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "cards create", Description: "Create a card",
		Access:    "write",
		Arguments: []plugin.ArgumentSpec{{Name: "title", Description: "Card title", Required: true}},
		Examples:  []string{"agentio board cards create Hello"},
		Run: func(_ context.Context, in plugin.CommandInput, run *plugin.RunContext) (any, error) {
			title, _ := in.Args["title"].(string)
			return map[string]any{"created": title, "token": run.Credentials["token"]}, nil
		},
	}
}
