package cli

import (
	"github.com/plosson/agentio/go/internal/service"
	gmailsvc "github.com/plosson/agentio/go/internal/services/gmail"
	jirasvc "github.com/plosson/agentio/go/internal/services/jira"
)

func init() {
	// Bun: SERVICE_PLUGINS / DEFAULT_PLUGIN_REGISTRY registration.
	// Adding a service = implement ServicePlugin + MustRegister here.
	// No changes to vault/profile packages required.
	service.Default.MustRegister(gmailsvc.New())
	service.Default.MustRegister(jirasvc.New())
}
