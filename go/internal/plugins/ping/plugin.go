// Package ping is a fake service with no stored credentials, the same shape as RSS.
package ping

import (
	"context"

	"github.com/plosson/agentio/go/internal/plugin"
)

func New() *plugin.Plugin {
	return &plugin.Plugin{
		APIVersion:  plugin.APIVersion,
		ID:          "ping",
		DisplayName: "Ping",
		Description: "Fake credential-less service",
		Commands: []plugin.CommandSpec{
			{
				Path: "once", Description: "Answer pong",
				Access: "read", Examples: []string{"agentio ping once"},
				Run: func(context.Context, plugin.CommandInput, *plugin.RunContext) (any, error) {
					return "pong", nil
				},
			},
			{
				Path: "echo", Description: "Echo a word",
				Arguments: []plugin.ArgumentSpec{{Name: "word", Description: "Word to echo", Required: true}},
				Examples:  []string{"agentio ping echo hello"},
				Run: func(_ context.Context, in plugin.CommandInput, _ *plugin.RunContext) (any, error) {
					return in.Args["word"], nil
				},
			},
		},
	}
}
