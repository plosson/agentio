package cli

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// runIn is run with stdin: a pipe, or a terminal (testbox.Terminal).
func runIn(t *testing.T, stdin io.Reader, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := Execute(testCatalog, args, &out, &errOut, stdin)
	return code, out.String(), errOut.String()
}

// feeds are the ways a pipe hands over the same answers.
func feeds(t *testing.T, answers string) map[string]func() io.Reader {
	half := len(answers) / 2
	return map[string]func() io.Reader{
		"one write": func() io.Reader { return strings.NewReader(answers) },
		"delayed writes": func() io.Reader {
			pr, pw := io.Pipe()
			go func() {
				testbox.Feed(pw, answers[:half], answers[half:])
				_ = pw.Close()
			}()
			return pr
		},
	}
}

// profiled is a vault with two board profiles that have no credentials and
// one acme profile that has them.
func profiled(t *testing.T) {
	t.Helper()
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("acme", "main", map[string]any{"account": "a", "refreshToken": "r"}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := vault.Update(func(c *vault.Contents) error {
		c.Config.Profiles["board"] = []vault.ProfileValue{{Name: "one"}, {Name: "two"}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func profileCount(t *testing.T) int {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, list := range c.Config.Profiles {
		n += len(list)
	}
	return n
}

const clearQuestion = "This will delete all profiles, credentials, and API keys. Are you sure? (y/n): "

// Bun vault clear asks through the line reader, so `echo y | agentio vault
// clear` clears, and anything else (or no answer) aborts with exit 0.
func TestVaultClearAsksAndReadsAPipedAnswer(t *testing.T) {
	for _, answer := range []string{"y\n", "YES", " y \r\n"} {
		for name, stdin := range feeds(t, answer) {
			profiled(t)
			code, out, errOut := runIn(t, stdin(), "vault", "clear")
			if code != 0 || out != "Configuration cleared\n" || errOut != clearQuestion {
				t.Fatalf("%q %s: code %d stdout %q stderr %q", answer, name, code, out, errOut)
			}
			if n := profileCount(t); n != 0 {
				t.Fatalf("%q %s: %d profiles left", answer, name, n)
			}
		}
	}
	for _, answer := range []string{"n\n", "", "yep\n", "\n"} {
		profiled(t)
		code, out, errOut := runIn(t, strings.NewReader(answer), "vault", "clear")
		if code != 0 || out != "" || errOut != clearQuestion+"Aborted\n" {
			t.Fatalf("%q: code %d stdout %q stderr %q", answer, code, out, errOut)
		}
		if n := profileCount(t); n != 3 {
			t.Fatalf("%q: vault changed, %d profiles", answer, n)
		}
	}
	profiled(t)
	if code, out, errOut := runIn(t, strings.NewReader(""), "vault", "clear", "--force"); code != 0 || out != "Configuration cleared\n" || errOut != "" {
		t.Fatalf("--force: %d %q %q", code, out, errOut)
	}
}

// Bun vault reset: off a terminal it refuses without --force; on one it asks
// (default no), and a reset also deletes the legacy .bak files.
func TestVaultResetConfirmsOnATerminalAndDeletesLegacyBackups(t *testing.T) {
	backups := func() []string {
		var out []string
		for _, name := range []string{"config.json.bak", "tokens.enc.bak"} {
			out = append(out, filepath.Join(vault.ConfigDir(), name))
		}
		return out
	}
	withBackups := func() {
		profiled(t)
		for _, p := range backups() {
			if err := os.WriteFile(p, []byte("old"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	gone := func(p string) bool { _, err := os.Stat(p); return os.IsNotExist(err) }

	withBackups()
	code, out, errOut := runIn(t, strings.NewReader("y\n"), "vault", "reset")
	if code != 1 || out != "" || errOut != "Error [INVALID_PARAMS]: Refusing to reset without confirmation and no terminal is available to prompt\nSuggestion: Re-run with --force if you are sure\n" {
		t.Fatalf("off a terminal: %d %q %q", code, out, errOut)
	}

	for _, answer := range []string{"\n", "n\n", "maybe\n"} {
		withBackups()
		code, out, errOut = runIn(t, testbox.Terminal(strings.NewReader(answer)), "vault", "reset")
		if code != 0 || out != "" || !strings.HasSuffix(errOut, "Aborted\n") ||
			!strings.Contains(errOut, "This will delete the vault, pointer, and stored passphrase. Continue?") {
			t.Fatalf("%q: %d %q %q", answer, code, out, errOut)
		}
		if !vault.Exists() || gone(backups()[0]) {
			t.Fatalf("%q: something was deleted", answer)
		}
	}

	for _, stdin := range []io.Reader{testbox.Terminal(strings.NewReader("yes\n")), strings.NewReader("")} {
		withBackups()
		args := []string{"vault", "reset"}
		if _, tty := stdin.(interface{ IsTerminal() bool }); !tty {
			args = append(args, "--force")
		}
		code, out, _ = runIn(t, stdin, args...)
		if code != 0 || out != "Vault reset. Run `agentio vault init` to start fresh.\n" {
			t.Fatalf("%v: %d %q", args, code, out)
		}
		for _, p := range backups() {
			if !gone(p) {
				t.Fatalf("%v: %s left behind", args, p)
			}
		}
		if vault.Exists() {
			t.Fatalf("%v: vault left", args)
		}
	}
}

// Bun's new-passphrase prompt asks again while the passphrase is too short,
// then asks for it once more; a mismatch is INVALID_PARAMS.
func TestNewPassphrasePromptAsksAgainWhenTooShort(t *testing.T) {
	initCLI(t)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	path := filepath.Join(os.Getenv("HOME"), "v.enc")
	stdin := testbox.Terminal(strings.NewReader("short\nlong-enough\nlong-enough\n"))
	code, out, errOut := runIn(t, stdin, "vault", "init", "--path", path, "--no-migrate")
	if code != 0 || !strings.HasPrefix(out, "Vault created at "+path+"\n") {
		t.Fatalf("%d %q %q", code, out, errOut)
	}
	if strings.Count(errOut, "Passphrase must be at least 8 characters") != 1 || strings.Count(errOut, "Confirm passphrase:") != 1 {
		t.Fatalf("prompts %q", errOut)
	}
	if _, err := vault.Load(); err != nil {
		t.Fatalf("vault does not open with the passphrase: %v", err)
	}

	os.Setenv("AGENTIO_PASSPHRASE", "") // vault init set it in this process
	stdin = testbox.Terminal(strings.NewReader("new-pass-1\nnew-pass-2\n"))
	code, out, errOut = runIn(t, stdin, "vault", "passphrase")
	if code != 1 || out != "" || !strings.HasSuffix(errOut, "Error [INVALID_PARAMS]: Passphrases do not match\n") {
		t.Fatalf("mismatch: %d %q %q", code, out, errOut)
	}
}

// Bun vault export on a terminal without --all: "All profiles (N)" (the
// default) or a checkbox of `service: profile`, none checked, one required.
func TestVaultExportPicksProfilesOnATerminal(t *testing.T) {
	key := strings.Repeat("ab", 32)
	exported := func(out string) string {
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, "AGENTIO_CONFIG=") {
				plain, err := vault.Decrypt(strings.TrimPrefix(line, "AGENTIO_CONFIG="), key)
				if err != nil {
					t.Fatal(err)
				}
				return plain
			}
		}
		t.Fatalf("no AGENTIO_CONFIG in %q", out)
		return ""
	}
	cases := []struct{ answers, wantErr, wantBlob string }{
		{"\n", "Exported 3 profiles\n", ""},
		{"2\n3\n\n", "Exported 1 profile\n", `{"version":1,"config":{"profiles":{"board":["two"]}},"credentials":{}}`},
		{"2\n1 2\n\n", "Exported 2 profiles\n", `{"version":1,"config":{"profiles":{"acme":["main"],"board":["one"]}},"credentials":{"acme":{"main":{"account":"a","refreshToken":"r"}}}}`},
	}
	for _, c := range cases {
		profiled(t)
		code, out, errOut := runIn(t, testbox.Terminal(strings.NewReader(c.answers)), "vault", "export", "--key", key)
		if code != 0 || !strings.HasSuffix(errOut, c.wantErr) || !strings.HasPrefix(out, "AGENTIO_KEY="+key+"\n") {
			t.Fatalf("%q: %d %q %q", c.answers, code, out, errOut)
		}
		for _, shown := range []string{"What would you like to export?", "All profiles (3)", "Select specific profiles"} {
			if !strings.Contains(errOut, shown) {
				t.Fatalf("%q: menu lacks %q: %q", c.answers, shown, errOut)
			}
		}
		if c.wantBlob != "" {
			if !strings.Contains(errOut, "Select profiles to export:") || !strings.Contains(errOut, "acme: main") || !strings.Contains(errOut, "board: two") {
				t.Fatalf("%q: checkbox %q", c.answers, errOut)
			}
			if got := exported(out); got != c.wantBlob {
				t.Fatalf("%q: blob\n got %s\nwant %s", c.answers, got, c.wantBlob)
			}
		}
	}
	profiled(t)
	code, out, errOut := runIn(t, testbox.Terminal(strings.NewReader("2\n\n")), "vault", "export")
	if code != 1 || out != "" || !strings.HasSuffix(errOut, "Error [INVALID_PARAMS]: At least one option must be selected\n") {
		t.Fatalf("empty pick: %d %q %q", code, out, errOut)
	}
	// Off a terminal: everything, no menu, stdin untouched.
	profiled(t)
	code, out, errOut = runIn(t, strings.NewReader("2\n\n"), "vault", "export")
	if code != 0 || errOut != "Exported 3 profiles\n" || !strings.Contains(out, "AGENTIO_CONFIG=") {
		t.Fatalf("piped: %d %q %q", code, out, errOut)
	}
}

// Bun reauth says it is checking, then (without --all) offers every invalid
// profile, all checked: off a terminal that is all of them.
func TestReauthOffersTheInvalidProfiles(t *testing.T) {
	skip := func(name string) string {
		return "\nSkipping board / " + name + ": no automatic reauthentication is registered. Run 'agentio board profile add --profile " + name + "' to update.\n"
	}
	const checking = "Checking profile credentials...\n\n"
	for name, stdin := range feeds(t, "1\n") {
		profiled(t)
		code, out, errOut := runIn(t, stdin(), "reauth")
		if code != 0 || out != "\nDone.\n" || errOut != checking+skip("one")+skip("two") {
			t.Fatalf("%s: %d %q %q", name, code, out, errOut)
		}
	}
	profiled(t)
	code, out, errOut := runIn(t, testbox.Terminal(strings.NewReader("1\n\n")), "reauth")
	if code != 0 || out != "\nDone.\n" || !strings.HasPrefix(errOut, checking) || !strings.HasSuffix(errOut, skip("two")) || strings.Contains(errOut, "Skipping board / one") {
		t.Fatalf("pick two: %d %q %q", code, out, errOut)
	}
	if !strings.Contains(errOut, "Select profiles to re-authenticate:") || !strings.Contains(errOut, "board / one (no credentials)") {
		t.Fatalf("checkbox %q", errOut)
	}
	profiled(t)
	code, out, errOut = runIn(t, testbox.Terminal(strings.NewReader("i\n\n")), "reauth")
	if code != 1 || out != "" || !strings.HasSuffix(errOut, "Error [INVALID_PARAMS]: At least one option must be selected\n") {
		t.Fatalf("none: %d %q %q", code, out, errOut)
	}
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	code, out, errOut = runIn(t, strings.NewReader(""), "reauth")
	if code != 0 || out != "All profiles are valid.\n" || errOut != checking {
		t.Fatalf("none invalid: %d %q %q", code, out, errOut)
	}
}

// Bun keeps hidden `setup` and `config` stubs that name their replacement,
// behind the vault gate, taking any argument or option.
func TestSetupAndConfigStubs(t *testing.T) {
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"setup":  "Error [INVALID_PARAMS]: `agentio setup` was removed in 2.0\nSuggestion: use `agentio vault init` (see: agentio vault --help)\n",
		"config": "Error [INVALID_PARAMS]: `agentio config` was removed in 2.0\nSuggestion: use `agentio vault export | import | clear` (see: agentio vault --help)\n",
	}
	for name, want := range cases {
		for _, extra := range [][]string{nil, {"export", "--all", "-x", "--json"}} {
			code, out, errOut := run(t, append([]string{name}, extra...)...)
			if code != 1 || out != "" || errOut != want {
				t.Fatalf("%s %v: %d %q %q", name, extra, code, out, errOut)
			}
		}
		// The help layout itself is Commander's in Bun (H5, not this test).
		code, out, errOut := run(t, name, "--help")
		if code != 0 || !strings.Contains(out, "agentio "+name) || errOut != "" {
			t.Fatalf("%s --help: %d %q %q", name, code, out, errOut)
		}
		if _, out, _ := run(t, "--help"); strings.Contains(out, " "+name+" ") {
			t.Fatalf("%s is listed in help", name)
		}
	}
	testbox.Isolate(t)
	code, _, errOut := run(t, "setup")
	if code != 2 || errOut != "Error [VAULT_NOT_CONFIGURED]: No vault configured\nSuggestion: Run: agentio vault init\n" {
		t.Fatalf("no vault: %d %q", code, errOut)
	}
}
