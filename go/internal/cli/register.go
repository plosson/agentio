package cli

import (
	"github.com/plosson/agentio/go/internal/plugin"
	gmailsvc "github.com/plosson/agentio/go/internal/plugins/gmail"
	jirasvc "github.com/plosson/agentio/go/internal/plugins/jira"
)

func init() {
	// Bun: SERVICE_PLUGINS / DEFAULT_PLUGIN_REGISTRY registration.
	// Adding a service = implement ServicePlugin + MustRegister here.
	// No changes to vault/profile packages required.
	plugin.Default.MustRegister(gmailsvc.New())
	plugin.Default.MustRegister(jirasvc.New())
}
