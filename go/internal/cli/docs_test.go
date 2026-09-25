package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// Bun's reference and skills for its catalog minus telegram (out of scope).
const bunReference = `
import { createProgram } from './src/cli';
import { PluginRegistry } from './src/plugins/plugin-registry';
import { SERVICE_PLUGINS } from './src/plugins/registry';
import { renderDocs } from './src/commands/docs';
import { generateSkill, listServices } from './src/commands/skill';
const program = createProgram(new PluginRegistry(SERVICE_PLUGINS.filter((p) => p.id !== 'telegram')));
const list = listServices(program);
const skills = Object.fromEntries(list.map((s) => [s, generateSkill(program, s)]));
await Bun.write(process.env.OUT, JSON.stringify({
  version: program.version(),
  docs: renderDocs(program, {}),
  json: renderDocs(program, { format: 'json' }),
  key: renderDocs(program, { service: ['key', 'status', 'vault'] }),
  list,
  skills,
}));
`

type bunDocs struct {
	Version string            `json:"version"`
	Docs    string            `json:"docs"`
	JSON    string            `json:"json"`
	Key     string            `json:"key"`
	List    []string          `json:"list"`
	Skills  map[string]string `json:"skills"`
}

func bunReferenceOutput(t *testing.T) bunDocs {
	t.Helper()
	var ref bunDocs
	if err := json.Unmarshal(runBun(t, bunReference), &ref); err != nil {
		t.Fatal(err)
	}
	return ref
}

// notPorted are Bun command groups the Go CLI does not have: `plugin verify`
// (external plugins are out of scope; Go's `plugin list` is its own), and
// `update` while it is not ported. Anything else must match.
var notPorted = map[string]bool{"plugin": true, "update": true}

// withoutGroups drops the `## agentio <group> …` sections of a Markdown text
// whose sections start with "## agentio ".
func withoutGroups(text string, groups map[string]bool) string {
	parts := strings.Split(text, "\n## agentio ")
	kept := []string{parts[0]}
	for _, part := range parts[1:] {
		if !groups[strings.Fields(part)[0]] {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "\n## agentio ")
}

func productionRun(args ...string) (int, string, string) {
	var out, errOut bytes.Buffer
	code := Execute(plugins.Default, args, &out, &errOut, strings.NewReader(""))
	return code, out.String(), errOut.String()
}

func withVault(t *testing.T) {
	t.Helper()
	initCLI(t)
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
}

// docs and skill print, byte for byte, what Bun's command tree generates.
func TestDocsAndSkillAreBunsReference(t *testing.T) {
	ref := bunReferenceOutput(t)
	withVault(t)
	saved := Version
	Version = ref.Version
	t.Cleanup(func() { Version = saved })

	code, out, errOut := productionRun("docs")
	if code != 0 || errOut != "" {
		t.Fatalf("docs: %d %q", code, errOut)
	}
	if got, want := withoutGroups(out, notPorted), withoutGroups(ref.Docs+"\n", notPorted); got != want {
		t.Errorf("docs differ from Bun:\n%s", firstDifference(got, want))
	}
	code, out, _ = productionRun("docs", "--service", "key,status, vault")
	if code != 0 || out != ref.Key+"\n" {
		t.Errorf("docs --service:\n%s", firstDifference(out, ref.Key+"\n"))
	}

	type entry = map[string]any
	decode := func(raw string) (string, []entry) {
		var doc struct {
			Version  string  `json:"version"`
			Commands []entry `json:"commands"`
		}
		if err := json.Unmarshal([]byte(raw), &doc); err != nil {
			t.Fatalf("docs --format json: %v\n%s", err, raw)
		}
		var kept []entry
		for _, c := range doc.Commands {
			if !notPorted[strings.Fields(c["command"].(string))[1]] {
				kept = append(kept, c)
			}
		}
		return doc.Version, kept
	}
	_, out, _ = productionRun("docs", "--format", "json")
	gotVersion, got := decode(out)
	wantVersion, want := decode(ref.JSON)
	if gotVersion != wantVersion || !reflect.DeepEqual(got, want) {
		t.Errorf("docs --format json differs from Bun")
	}

	_, out, _ = productionRun("skill", "--list")
	var wantList []string
	for _, s := range ref.List {
		if !notPorted[s] {
			wantList = append(wantList, s)
		}
	}
	var gotList []string
	for _, s := range strings.Fields(out) {
		if !notPorted[s] {
			gotList = append(gotList, s)
		}
	}
	if got := gotList; !reflect.DeepEqual(got, wantList) {
		t.Errorf("skill --list\n got %v\nwant %v", got, wantList)
	}
	for _, s := range wantList {
		code, out, errOut := productionRun("skill", s)
		if code != 0 || errOut != "" || out != ref.Skills[s]+"\n" {
			t.Errorf("skill %s (%d %q):\n%s", s, code, errOut, firstDifference(out, ref.Skills[s]+"\n"))
		}
	}
}

func firstDifference(got, want string) string {
	g, w := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := 0; i < len(g) || i < len(w); i++ {
		var gl, wl string
		if i < len(g) {
			gl = g[i]
		}
		if i < len(w) {
			wl = w[i]
		}
		if gl != wl || i >= len(g) || i >= len(w) {
			return "line " + itoa(i+1) + "\n got " + quote(gl) + "\nwant " + quote(wl)
		}
	}
	return "same"
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }
func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestDocsRefusesAnUnknownFormatAndFiltersExactly(t *testing.T) {
	testbox.Isolate(t)
	for _, format := range []string{"xml", "JSON", " json", ""} {
		code, out, errOut := productionRun("docs", "--format", format)
		want := "Error [INVALID_PARAMS]: Unknown format: " + format + "\nSuggestion: Use --format markdown or --format json\n"
		if code != 1 || out != "" || errOut != want {
			t.Errorf("--format %q: %d %q %q", format, code, out, errOut)
		}
	}
	// An empty name selects nothing, not everything.
	if code, out, _ := productionRun("docs", "--service", ""); code != 0 || out != "# agentio CLI v"+Version+"\n" {
		t.Errorf("--service '': %d %q", code, out)
	}
	// status is left out unless named; the host --json is not Bun's and is not listed.
	_, out, _ := productionRun("docs")
	if strings.Contains(out, "## agentio status") || strings.Contains(out, "Output structured JSON") || strings.Contains(out, "profile add") {
		t.Errorf("docs lists status, the host --json or a profile command")
	}
	_, out, _ = productionRun("docs", "--service", "status")
	if !strings.Contains(out, "## agentio status\nShow configured profiles and credential status\n--no-test: Skip credential testing\n--json: Output in JSON format") {
		t.Errorf("docs --service status:\n%s", out)
	}
	// Hidden commands (docs, skill, reauth) are not part of the reference.
	for _, hidden := range []string{"docs", "skill", "reauth"} {
		if _, out, _ := productionRun("docs", "--service", hidden); out != "# agentio CLI v"+Version+"\n" {
			t.Errorf("docs lists hidden %s:\n%s", hidden, out)
		}
	}
}

func TestSkillIsBunsForEveryCommandGroup(t *testing.T) {
	withVault(t)
	code, out, errOut := productionRun("skill")
	if code != 1 || out != "" || errOut != "Error [INVALID_PARAMS]: specify a service, --all, or --list\n" {
		t.Errorf("skill: %d %q %q", code, out, errOut)
	}
	code, out, errOut = productionRun("skill", "nope")
	if code != 5 || out != "" || errOut != "Error [NOT_FOUND]: no commands found for service \"nope\"\n" {
		t.Errorf("skill nope: %d %q %q", code, out, errOut)
	}
	// A profile subcommand is not a group of its own.
	if code, _, _ := productionRun("skill", "profile"); code != 5 {
		t.Errorf("skill profile: %d", code)
	}
	// Groups that are not plugins: key uses its own description, login the generic one.
	_, out, _ = productionRun("skill", "key")
	for _, want := range []string{
		"---\nname: agentio-key\ndescription: Use to manage the API keys that let remote agents read credentials from this vault hub - create, list, update, rotate, revoke.\n---\n\n# Key via agentio\n\nAuto-generated from `agentio skill key`. Do not edit by hand.\n\n## agentio key create <name>\n",
		"- `--read-only`: Force read-only on every profile the key can see (default: false)\n",
		"- `--no-read-only`: Lift the key-level read-only restriction\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("skill key lacks %q:\n%s", want, out)
		}
	}
	_, out, _ = productionRun("skill", "login")
	if !strings.HasPrefix(out, "---\nname: agentio-login\ndescription: Use when interacting with login via the agentio CLI.\n---\n\n# Login via agentio\n") ||
		!strings.Contains(out, "## agentio login <hub-url>\n\nGet a key") || !strings.HasSuffix(out, "```\n\n") {
		t.Errorf("skill login:\n%s", out)
	}
	// --list wins over a service and over --all.
	_, listed, _ := productionRun("skill", "--list")
	if _, out, _ := productionRun("skill", "gmail", "--all", "--list"); out != listed {
		t.Errorf("skill gmail --all --list:\n%s", out)
	}
	for _, want := range []string{"daemon\n", "key\n", "login\n", "logout\n", "status\n", "vault\n", "gmail\n"} {
		if !strings.Contains(listed, want) {
			t.Errorf("skill --list lacks %q", want)
		}
	}
	if groups := "\n" + listed; strings.Contains(groups, "\nprofile\n") || strings.Contains(groups, "\nskill\n") || strings.Contains(groups, "\ndocs\n") || strings.Contains(groups, "\nreauth\n") {
		t.Errorf("skill --list shows a hidden or profile group:\n%s", listed)
	}
}

// skill --all writes each SKILL.md under ./claude/skills, relative to the
// working directory, and says so on stderr.
func TestSkillAllWritesUnderTheWorkingDirectory(t *testing.T) {
	withVault(t)
	dir := t.TempDir()
	t.Chdir(dir)
	code, out, errOut := productionRun("skill", "--all", "gmail")
	if code != 0 || out != "" {
		t.Fatalf("skill --all: %d %q %q", code, out, errOut)
	}
	_, listed, _ := productionRun("skill", "--list")
	var want strings.Builder
	for _, s := range strings.Fields(listed) {
		want.WriteString("wrote claude/skills/agentio-" + s + "/SKILL.md\n")
	}
	if errOut != want.String() {
		t.Errorf("stderr\n got %q\nwant %q", errOut, want.String())
	}
	written, err := os.ReadFile(filepath.Join(dir, "claude", "skills", "agentio-key", "SKILL.md"))
	_, printed, _ := productionRun("skill", "key")
	if err != nil || string(written)+"\n" != printed {
		t.Errorf("SKILL.md is not the printed skill: %v", err)
	}
}

// Bun's gate: skill needs a vault; docs, vault, login, logout, plugin, doctor
// and update, and any command so named, do not.
func TestVaultGateIsBuns(t *testing.T) {
	initCLI(t)
	t.Setenv("AGENTIO_PASSPHRASE", "")
	noVault := "Error [VAULT_NOT_CONFIGURED]: No vault configured\nSuggestion: Run: agentio vault init\n"
	for _, args := range [][]string{{"skill", "gmail"}, {"skill"}, {"skill", "--list"}, {"gmail", "list"}} {
		code, out, errOut := productionRun(args...)
		if code != 2 || out != "" || errOut != noVault {
			t.Errorf("%v: %d %q %q", args, code, out, errOut)
		}
	}
	if code, _, errOut := productionRun("docs"); code != 0 || errOut != "" {
		t.Errorf("docs is gated: %d %q", code, errOut)
	}
	// Bun bypasses the gate on the command name alone, so a service command
	// named `update` reaches the vault, which then refuses in its own words.
	code, out, errOut := productionRun("confluence", "update", "123", "--content", "x")
	want := "Error [VAULT_NOT_CONFIGURED]: agentio is not configured yet\nSuggestion: Run `agentio vault init` to create one, or `agentio vault set <path>` to use an existing vault.\n"
	if code != 2 || out != "" || errOut != want {
		t.Errorf("confluence update: %d %q %q", code, out, errOut)
	}
}
