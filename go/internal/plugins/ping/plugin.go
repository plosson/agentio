// Package ping is a fake service with no stored credentials, the same shape as RSS.
package ping

import (
	"context"

	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "ping",
		DisplayName: "Ping",
		Description: "Fake credential-less service",
		Commands: []plugins.CommandSpec{
			{
				Path: "once", Description: "Answer pong",
				Access: "read", Examples: []string{"agentio ping once"},
				Run: func(context.Context, plugins.CommandInput, *plugins.RunContext) (any, error) {
					return "pong", nil
				},
			},
			{
				Path: "echo", Description: "Echo a word",
				Arguments: []plugins.ArgumentSpec{{Name: "word", Description: "Word to echo", Required: true}},
				Examples:  []string{"agentio ping echo hello"},
				Run: func(_ context.Context, in plugins.CommandInput, _ *plugins.RunContext) (any, error) {
					return in.Args["word"], nil
				},
			},
		},
	}
}
