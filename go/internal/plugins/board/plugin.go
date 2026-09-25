// Package board is a fake static-token service. It has credentials and a
// write gate, and no refresh lifecycle, so the hub hands the token over whole.
package board

import (
	"context"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

const ServiceID = "board"

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          ServiceID,
		DisplayName: "Board",
		Description: "Fake static-token service with no refresh lifecycle",
		Profile: &plugins.ProfileSpec{
			Setup:    setup,
			Validate: validate,
		},
		Commands: []plugins.CommandSpec{cardsList(), cardsCreate()},
	}
}

func setup(_ context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
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
	return &plugins.SetupResult{
		Credentials:          jsvalue.ObjectOf("token", token, "workspace", workspace),
		SuggestedProfileName: workspace,
		Info:                 "Workspace: " + workspace,
	}, nil
}

func validate(_ context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	token, _ := run.Credentials.Value("token").(string)
	workspace, _ := run.Credentials.Value("workspace").(string)
	if token == "" || token == "expired" {
		return plugins.ValidationResult{Valid: false, Error: "token rejected"}, nil
	}
	return plugins.ValidationResult{Valid: true, Info: "Workspace: " + workspace}, nil
}

func cardsList() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path: "cards list", Description: "List cards in the workspace",
		Access: "read", Examples: []string{"agentio board cards list"},
		Run: func(_ context.Context, _ plugins.CommandInput, run *plugins.RunContext) (any, error) {
			return map[string]any{"workspace": run.Credentials.Value("workspace"), "cards": []string{}}, nil
		},
	}
}

func cardsCreate() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path: "cards create", Description: "Create a card",
		Access:    "write",
		Arguments: []plugins.ArgumentSpec{{Name: "title", Description: "Card title", Required: true}},
		Examples:  []string{"agentio board cards create Hello"},
		Run: func(_ context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			title, _ := in.Args["title"].(string)
			return map[string]any{"created": title, "token": run.Credentials.Value("token")}, nil
		},
	}
}
