package plugin_test

import (
	"context"
	"testing"

	"github.com/plosson/agentio/go/internal/plugin"
	gmailsvc "github.com/plosson/agentio/go/internal/plugins/gmail"
	jirasvc "github.com/plosson/agentio/go/internal/plugins/jira"
)

// Stress-test: Gmail and Jira both satisfy ServicePlugin and register side-by-side
// without special-casing vault or profile.
func TestGmailAndJiraShareServicePluginContract(t *testing.T) {
	r := plugin.NewRegistry()
	r.MustRegister(gmailsvc.New())
	r.MustRegister(jirasvc.New())

	if got := r.Names(); len(got) != 2 {
		t.Fatalf("want 2 services, got %v", got)
	}
	for _, id := range []string{"gmail", "jira"} {
		p, ok := r.Find(id)
		if !ok {
			t.Fatalf("missing %s", id)
		}
		if p.ID() != id {
			t.Fatalf("id: %s", p.ID())
		}
		if p.DisplayName() == "" || p.Description() == "" {
			t.Fatalf("%s missing display/description", id)
		}
		var _ plugin.ServicePlugin = p
		_ = context.Background()
	}
}
