package service_test

import (
	"context"
	"testing"

	"github.com/plosson/agentio/go/internal/service"
	gmailsvc "github.com/plosson/agentio/go/internal/services/gmail"
	jirasvc "github.com/plosson/agentio/go/internal/services/jira"
)

// Stress-test: Gmail and Jira both satisfy ServicePlugin and register side-by-side
// without special-casing vault or profile.
func TestGmailAndJiraShareServicePluginContract(t *testing.T) {
	r := service.NewRegistry()
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
		var _ service.ServicePlugin = p
		_ = context.Background()
	}
}
