package cli

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/daemon"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/vault"
	"github.com/spf13/cobra"
)

// check is one line of Bun's doctor: a status, a detail, and the fix to run.
type check struct {
	name, status, detail, fix string
}

var checkSymbol = map[string]string{"ok": "✓", "warn": "!", "error": "✗"}

// renderChecks is Bun's renderChecks: the symbol and name padded to 20, the
// detail after an em dash, then an indented fix line.
func renderChecks(checks []check) string {
	var lines []string
	for _, c := range checks {
		head := jsvalue.PadEnd(checkSymbol[c.status]+" "+c.name, 20)
		detail := ""
		if c.detail != "" {
			detail = "— " + c.detail
		}
		lines = append(lines, strings.TrimRightFunc(head+" "+detail, jsvalue.IsSpace))
		if c.fix != "" {
			lines = append(lines, "    fix: "+c.fix)
		}
	}
	return strings.Join(lines, "\n")
}

func checkVault() (check, error) {
	present, err := vault.Present()
	if err != nil {
		return check{}, err
	}
	if !present {
		return check{name: "Vault", status: "error", detail: "not configured", fix: "agentio vault init"}, nil
	}
	path, err := vault.ReadPointer()
	if err != nil {
		return check{}, err
	}
	return check{name: "Vault", status: "ok", detail: "at " + path}, nil
}

// checkHub is remote mode's only check: one listing proves reachability, the
// token, and the hub's lock state.
func checkHub() (check, error) {
	h, err := auth.Hub()
	if err != nil {
		return check{}, err
	}
	profiles, err := auth.RemoteProfiles()
	var manage *bool
	if err == nil {
		manage, err = auth.RemoteCanManage()
	}
	if err != nil {
		c := check{name: "Hub", status: "error", detail: errorMessage(err)}
		if ce, ok := err.(*clierr.Error); ok {
			c.fix = ce.Suggestion
		}
		return c, nil
	}
	may := ""
	if manage != nil && *manage {
		may = ", can manage profiles"
	}
	return check{name: "Hub", status: "ok", detail: fmt.Sprintf("%s, %d profile(s) allowed for this token%s", h.URL, len(profiles), may)}, nil
}

func checkDaemon() check {
	health := daemon.ProbeHealth()
	if health == nil {
		return check{name: "Daemon", status: "warn", detail: "not running", fix: "agentio daemon start"}
	}
	if health.Locked {
		return check{name: "Daemon", status: "warn", detail: "running, vault locked"}
	}
	return check{name: "Daemon", status: "ok", detail: "running"}
}

func checkProfiles() check {
	contents, err := vault.Load()
	if err != nil {
		return check{name: "Profiles", status: "error", detail: "cannot read config"}
	}
	total := profileCount(contents)
	if total == 0 {
		return check{name: "Profiles", status: "warn", detail: "no services configured",
			fix: "agentio <service> profile add (e.g. gmail, slack, telegram)"}
	}
	return check{name: "Profiles", status: "ok", detail: fmt.Sprintf("%d configured", total)}
}

func doctorCmd() *cobra.Command {
	return &cobra.Command{
		Use: "doctor", Short: "Diagnose vault, daemon, and profiles",
		Example: `  # run all health checks (vault, daemon, profiles)
  agentio doctor`,
		RunE: func(c *cobra.Command, _ []string) error {
			var checks []check
			if auth.IsRemote() {
				hub, err := checkHub()
				if err != nil {
					return err
				}
				checks = []check{hub}
			} else {
				v, err := checkVault()
				if err != nil {
					return err
				}
				checks = []check{v, checkDaemon(), checkProfiles()}
			}
			fmt.Fprintln(c.OutOrStdout(), renderChecks(checks))
			for _, ch := range checks {
				if ch.status == "error" {
					return &plugins.ExitStatus{Code: 1}
				}
			}
			return nil
		},
	}
}
