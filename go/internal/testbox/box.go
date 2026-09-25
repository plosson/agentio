// Package testbox points HOME at a temp directory and clears process caches
// so a test cannot touch a real vault, and fakes the network failures tests need.
package testbox

import (
	"io"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/vault"
)

func Isolate(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AGENTIO_TEST", "1")
	t.Setenv("AGENTIO_PASSPHRASE", "")
	t.Setenv("AGENTIO_TOKEN", "")
	t.Setenv("AGENTIO_KEY", "")
	t.Setenv("AGENTIO_CONFIG", "")
	t.Setenv("AGENTIO_PASSPHRASE_STORE", "")
	t.Setenv("AGENTIO_KEEPALIVE_HOURS", "0")
	t.Setenv("AGENTIO_TRUSTED_IP_HEADER", "")
	vault.Reset()
	auth.Reset()
}

// Terminal is r read as a terminal (host.IsTerminal): a person at a keyboard,
// for the prompts that only run on one.
func Terminal(r io.Reader) io.Reader { return terminal{r} }

type terminal struct{ io.Reader }

func (terminal) IsTerminal() bool { return true }
