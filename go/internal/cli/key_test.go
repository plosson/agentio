package cli

import (
	"regexp"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
)

// Bun's `key` commands: `create <name>` with a required --url and an explicit
// scope, the token alone on stdout so `$(agentio key create …)` captures it,
// --[no-]read-only and --[no-]can-manage-profiles on update, and Bun's lines.
func TestKeyCommandsAreBuns(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	for _, ref := range [][2]string{{"acme", "ada"}, {"board", "desk"}} {
		if err := profile.Save(ref[0], ref[1], map[string]any{"x": "y"}, profile.SaveOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	expect := func(args string, code int, stdout, stderr string) {
		t.Helper()
		gotCode, out, errOut := run(t, strings.Fields(args)...)
		if gotCode != code || out != stdout || errOut != stderr {
			t.Fatalf("%s: code %d\nstdout %q\nstderr %q\nwant %d %q %q", args, gotCode, out, errOut, code, stdout, stderr)
		}
	}
	expect("key list", 0, "No API keys. Create one with: agentio key create <name> --url <hub-url> --all\n", "")
	expect("key create", 1, "", "error: required option '--url <url>' not specified\n")
	expect("key create --url https://h.example", 1, "", "error: missing required argument 'name'\n")
	expect("key create bot", 1, "", "error: required option '--url <url>' not specified\n")
	expect("key create bot --url https://h.example --profiles", 1, "", "error: option '--profiles <list>' argument missing\n")
	expect("key create bot --url https://h.example", 1, "", "Error [INVALID_PARAMS]: Choose a scope\nSuggestion: Pass --all or --profiles <service/name,...>\n")
	expect("key create bot --url https://h.example --all --profiles acme/ada", 1, "", "Error [INVALID_PARAMS]: --all and --profiles are mutually exclusive\n")
	expect("key create bot --url https://h.example --manage --all", 1, "", "error: unknown option '--manage'\n")
	if keys, _ := profile.ListKeys(); len(keys) != 0 {
		t.Fatalf("a refused create stored a key: %#v", keys)
	}

	code, out, errOut := run(t, "key", "create", "bot", "--url", "https://H.example:443/x", "--profiles", " acme/ada , ,board/desk", "--read-only", "--can-manage-profiles")
	keys, _ := profile.ListKeys()
	if code != 0 || len(keys) != 1 {
		t.Fatalf("create: code %d %q %q", code, out, errOut)
	}
	id := keys[0].ID
	token := strings.TrimSuffix(out, "\n")
	if parts, err := auth.DecodeToken(token); err != nil || parts.URL != "https://h.example" || parts.Kid != id || strings.Count(out, "\n") != 1 {
		t.Fatalf("stdout must be the token alone: %q (%v)", out, err)
	}
	if want := `Key "bot" (` + id + "), acme/ada, board/desk, read-only, can manage profiles\nThis token is shown once. Set it on the agent machine as AGENTIO_TOKEN.\n"; errOut != want {
		t.Fatalf("create stderr %q, want %q", errOut, want)
	}

	_, out, _ = run(t, "key", "list")
	line := regexp.MustCompile(`^` + regexp.QuoteMeta(id) + `  bot  agio1\.…[A-Za-z0-9_-]{4}  acme/ada, board/desk, read-only, can manage profiles  created \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z  never used\n$`)
	if !line.MatchString(out) || !strings.HasSuffix(strings.TrimSuffix(out, "  created "+keys[0].CreatedAt+"  never used\n"), keys[0].Hint+"  acme/ada, board/desk, read-only, can manage profiles") {
		t.Fatalf("list %q", out)
	}

	expect("key update "+id, 1, "", "Error [INVALID_PARAMS]: Nothing to update\nSuggestion: Pass at least one option; see --help\n")
	expect("key update "+id+" --no-read-only --no-can-manage-profiles", 0, `Updated "bot" (`+id+"): acme/ada, board/desk\n", "")
	expect("key update "+id+" --no-read-only --read-only", 0, `Updated "bot" (`+id+"): acme/ada, board/desk, read-only\n", "")
	expect("key update "+id+" --read-only --no-read-only --can-manage-profiles", 0, `Updated "bot" (`+id+"): acme/ada, board/desk, can manage profiles\n", "")
	expect("key update "+id+" --all --name robot", 0, `Updated "robot" (`+id+"): all profiles, can manage profiles\n", "")
	expect("key update "+id+" --profiles board/desk --all", 1, "", "Error [INVALID_PARAMS]: --all and --profiles are mutually exclusive\n")
	expect("key update "+id+" --profiles acme/nope", 1, "", "Error [INVALID_PARAMS]: Unknown profile: acme/nope\nSuggestion: Use service/name pairs from `agentio profile list`\n")
	expect("key update "+id+" --manage", 1, "", "error: unknown option '--manage'\n(Did you mean --name?)\n")

	expect("key rotate "+id, 1, "", "error: required option '--url <url>' not specified\n")
	code, out, errOut = run(t, "key", "rotate", id, "--url", "http://h2.example")
	if parts, err := auth.DecodeToken(strings.TrimSuffix(out, "\n")); code != 0 || err != nil || parts.URL != "http://h2.example" || strings.Count(out, "\n") != 1 {
		t.Fatalf("rotate: code %d %q %q", code, out, errOut)
	}
	if want := `Key "robot" (` + id + "), all profiles, can manage profiles\nThis token is shown once. Set it on the agent machine as AGENTIO_TOKEN.\n"; errOut != want {
		t.Fatalf("rotate stderr %q", errOut)
	}
	expect("key revoke "+id, 0, "Revoked "+id+"\n", "")
	expect("key revoke "+id, 5, "", "Error [NOT_FOUND]: No key with id "+id+"\nSuggestion: Run: agentio key list\n")
}
