package gdrive

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google/googletest"
	"github.com/plosson/agentio/go/internal/vault"
)

// product drives New() through the shared Google test harness.
var product = googletest.For(New)

// storedCreds is a Bun GDriveCredentials object (camelCase keys).
func storedCreds(expiry int64, accessLevel string) map[string]any {
	c := map[string]any{
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"tokenType":    "Bearer",
		"scope":        "https://www.googleapis.com/auth/drive",
		"email":        "me@example.com",
	}
	if accessLevel != "" {
		c["accessLevel"] = accessLevel
	}
	return c
}

func fresh(accessLevel string) map[string]any {
	return storedCreds(time.Now().Add(time.Hour).UnixMilli(), accessLevel)
}

// The command table is the Bun surface: `bun run src/index.ts gdrive --help`
// and each leaf's --help.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op string
		prepare, format         bool
	}
	want := map[string]row{
		"list":        {"", "--limit <n>=20 --folder <id> --query <query> --order <field>=modifiedTime desc --trash", "read", "", false, true},
		"folders":     {"", "--limit <n>=20 --parent <id> --query <query>", "read", "", false, true},
		"get":         {"<file-id-or-url>", "", "read", "", false, true},
		"search":      {"", "--query <text>! --limit <n>=20 --type <mime> --folder <id>", "read", "", false, true},
		"download":    {"<file-id-or-url>", "--output <path>! --export <format>", "read", "", false, true},
		"put":         {"<file-path>", "--name <name> --folder <id> --type <mime> --convert --public", "write", "upload file", false, true},
		"copy":        {"<file-id-or-url>", "--name <name> --folder <id>", "write", "copy file", false, true},
		"mkdir":       {"<name>", "--parent <id>", "write", "create folder", false, true},
		"rename":      {"<file-id-or-url> <new-name>", "", "write", "rename file", false, true},
		"move":        {"<file-id-or-url> <folder-id-or-url>", "", "write", "move file", false, true},
		"trash":       {"<file-id-or-url>", "", "write", "trash file", false, true},
		"permissions": {"<file-id-or-url>", "", "read", "", false, true},
		"share":       {"<file-id-or-url>", "--anyone --user <email> --domain <domain> --group <email> --role <role>=reader --notify --message <text> --allow-discovery", "write", "share file", true, true},
		"unshare":     {"<file-id-or-url>", "--permission-id <id> --anyone", "write", "remove permission", true, true},
	}
	p := New()
	if p.ID != "gdrive" || p.DisplayName != "Google Drive" ||
		p.Description != "Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, " ") != "list folders get search download put copy mkdir rename move trash permissions share unshare" {
		t.Fatalf("order %v", order)
	}
	for _, c := range p.Commands {
		w, ok := want[c.Path]
		if !ok {
			t.Fatalf("unexpected command %q", c.Path)
		}
		var args, flags []string
		for _, a := range c.Arguments {
			if a.Required {
				args = append(args, "<"+a.Name+">")
			} else {
				args = append(args, "["+a.Name+"]")
			}
		}
		for _, o := range c.Options {
			// The host's --profile, placed as in Bun; the docs parity test checks it.
			if o.Flags == plugins.ProfileFlags {
				continue
			}
			f := o.Flags
			if o.Required {
				f += "!" // requiredOption
			}
			if d, ok := o.DefaultValue.(string); ok {
				f += "=" + d
			}
			if o.Repeatable {
				f += "*"
			}
			flags = append(flags, f)
		}
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Prepare != nil, c.Format != nil}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || len(c.Aliases) != 0 || c.Input != "" {
			t.Errorf("%s: examples %d aliases %v input %q", c.Path, len(c.Examples), c.Aliases, c.Input)
		}
	}
	var setupFlags []string
	for _, o := range p.Profile.SetupOptions {
		setupFlags = append(setupFlags, o.Flags)
	}
	if strings.Join(setupFlags, " ") != "--readonly --full" {
		t.Fatalf("profile add flags %v", setupFlags)
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken" {
		t.Fatal("gdrive is a camelCase Google lifecycle")
	}
}

func oauthSetup(t *testing.T, answer string, scopes *string, logs *[]string) *plugins.SetupContext {
	t.Helper()
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(answer), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) { *logs = append(*logs, parts[0].(string)) }
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		authURL, _ := url.Parse(o.AuthorizationURL("http://localhost:3001/callback"))
		*scopes = authURL.Query().Get("scope")
		if o.Port != 0 || o.ServiceName != "Google" || authURL.Query().Get("access_type") != "offline" || authURL.Query().Get("prompt") != "consent" {
			t.Errorf("oauth %#v %s", o, authURL)
		}
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:3001/callback"}, nil
	}
	return sc
}

const (
	fullScopes     = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email"
	readonlyScopes = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email"
)

func tokenAndEmail(t *testing.T) *googletest.Fake {
	return googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/drive"})
		case "/userinfo":
			if h.Auth != "Bearer at-1" {
				w.WriteHeader(401)
				return
			}
			googletest.WriteJSON(w, 200, map[string]any{"email": "user@example.com"})
		default:
			w.WriteHeader(404)
		}
	})
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := tokenAndEmail(t)
	var scopes string
	var logs []string
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{Options: map[string]any{"full": true, "readonly": false}}, oauthSetup(t, "", &scopes, &logs), &out)
	if err != nil {
		t.Fatal(err)
	}
	if scopes != fullScopes {
		t.Fatalf("scopes %q", scopes)
	}
	token := fake.Recorded()[0].Form
	if token.Get("grant_type") != "authorization_code" || token.Get("code") != "code-1" || token.Get("redirect_uri") != "http://localhost:3001/callback" {
		t.Fatalf("token request %v", token)
	}
	stored := product.LoadCreds(t, "user@example.com")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	// camelCase, as GDriveCredentials: a snake_case key would not open a Bun vault.
	if strings.Join(keys, ",") != "accessLevel,accessToken,email,expiryDate,refreshToken,scope,tokenType" {
		t.Fatalf("keys %v", keys)
	}
	if stored["accessToken"] != "at-1" || stored["refreshToken"] != "rt-1" || stored["email"] != "user@example.com" ||
		stored["tokenType"] != "Bearer" || stored["accessLevel"] != "full" {
		t.Fatalf("%#v", stored)
	}
	exp, ok := stored["expiryDate"].(json.Number)
	if !ok {
		t.Fatalf("expiryDate is %T, want a JSON number", stored["expiryDate"])
	}
	if n, _ := exp.Int64(); n < before+3599_000 || n > time.Now().UnixMilli()+3599_000 {
		t.Fatalf("expiry %d", n)
	}
	if out.String() != "Profile \"user@example.com\" configured!\nEmail: user@example.com\nAPI Access: Full (read & write)\nTest with: agentio gdrive list\n" {
		t.Fatalf("%q", out.String())
	}
	// The flags skip the access level prompt.
	if strings.Join(logs, "|") != "Google Drive Setup\n|\nStarting OAuth flow (full access)...\n" {
		t.Fatalf("%q", logs)
	}
}

// Only "2" picks full access; anything else, and --read-only, is readonly
// with the drive.readonly scope.
func TestSetupAccessLevelFromPromptAndFlags(t *testing.T) {
	for _, c := range []struct {
		name   string
		opts   plugins.SetupOptions
		answer string
		level  string
		scopes string
		asked  bool
	}{
		{"prompt 2", plugins.SetupOptions{}, " 2 \n", "full", fullScopes, true},
		{"prompt 1", plugins.SetupOptions{}, "1\n", "readonly", readonlyScopes, true},
		{"prompt junk", plugins.SetupOptions{}, "full\n", "readonly", readonlyScopes, true},
		{"prompt eof", plugins.SetupOptions{}, "", "readonly", readonlyScopes, true},
		{"--readonly beats --full", plugins.SetupOptions{Options: map[string]any{"readonly": true, "full": true}}, "2\n", "readonly", readonlyScopes, false},
		{"--read-only beats --full", plugins.SetupOptions{ReadOnly: true, Options: map[string]any{"full": true}}, "2\n", "readonly", readonlyScopes, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			fake := tokenAndEmail(t)
			var scopes string
			var logs []string
			res, err := New().Profile.Setup(fake.Ctx(), c.opts, oauthSetup(t, c.answer, &scopes, &logs))
			if err != nil {
				t.Fatal(err)
			}
			if res.Credentials["accessLevel"] != c.level || scopes != c.scopes || res.SuggestedProfileName != "user@example.com" {
				t.Fatalf("%#v %q", res.Credentials, scopes)
			}
			asked := strings.Contains(strings.Join(logs, "|"), "Access level options:")
			if asked != c.asked {
				t.Fatalf("asked %v: %q", asked, logs)
			}
			wantInfo := "API Access: Read-only"
			if c.level == "full" {
				wantInfo = "API Access: Full (read & write)"
			}
			if !strings.Contains(res.Info, wantInfo) {
				t.Fatalf("%q", res.Info)
			}
		})
	}
}

func TestSetupFailsWithBunsMessageWhenTheEmailIsMissing(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1"})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"id": "123"})
	})
	var scopes string
	var logs []string
	err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{Options: map[string]any{"full": true}}, oauthSetup(t, "", &scopes, &logs), io.Discard)
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.AuthFailed || ce.Message != "Failed to fetch user email: No email returned from userinfo endpoint" || ce.Suggestion != "Ensure the account has an email address" {
		t.Fatalf("%#v", ce)
	}
	if c, _ := vault.Load(); len(c.Credentials["gdrive"]) != 0 {
		t.Fatal("a failed setup saved a profile")
	}
}

// Bun never rotates a Google refresh token: a rotated one in the response is
// dropped, and every other stored field (accessLevel included) is kept.
func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := product.SetupVault(t)
	creds := storedCreds(1, "full")
	creds["legacy"] = "kept"
	product.SaveProfile(t, "acme", creds, false)
	var mu sync.Mutex
	refreshes := 0
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3599, "token_type": "Bearer"})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"files": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gdrive", "acme", auth.RefreshOptions{})
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if refreshes != 1 {
		t.Fatalf("%d refreshes, want 1", refreshes)
	}
	form := fake.Recorded()[0].Form
	if form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "rt-old" {
		t.Fatalf("refresh request %v", form)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-old" || stored["email"] != "me@example.com" ||
		stored["legacy"] != "kept" || stored["accessLevel"] != "full" || stored["scope"] != "https://www.googleapis.com/auth/drive" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiryDate"].(json.Number); !ok {
		t.Fatalf("expiryDate %T", stored["expiryDate"])
	}
	if _, ok := stored["access_token"]; ok {
		t.Fatal("refresh wrote a snake_case key")
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, nil)); err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if last := all[len(all)-1]; last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(1, "full"), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, nil))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gdrive profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gdrive profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

// driveFake answers every Drive call a command makes with a plausible body.
func driveFake(t *testing.T) *googletest.Fake {
	return googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case strings.HasSuffix(h.Path, "/permissions") && h.Method == "GET":
			googletest.WriteJSON(w, 200, map[string]any{"permissions": []any{map[string]any{"id": "anyoneWithLink", "type": "anyone", "role": "reader"}}})
		case strings.Contains(h.Path, "/permissions") && h.Method == "DELETE":
			w.WriteHeader(204)
		case strings.HasSuffix(h.Path, "/permissions"):
			googletest.WriteJSON(w, 200, map[string]any{"id": "perm-1", "type": "anyone", "role": "reader"})
		case h.Query.Get("alt") == "media":
			_, _ = io.WriteString(w, "bytes")
		case h.Path == "/files" && h.Method == "GET":
			googletest.WriteJSON(w, 200, map[string]any{"files": []any{}})
		default:
			googletest.WriteJSON(w, 200, map[string]any{"id": "f1", "name": "F", "mimeType": "application/pdf"})
		}
	})
}

func writeInputs(t *testing.T) (string, map[string]map[string]any) {
	t.Helper()
	local := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(local, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	return local, map[string]map[string]any{
		"put":     {"file-path": local},
		"copy":    {"file-id-or-url": "f1"},
		"mkdir":   {"name": "Reports"},
		"rename":  {"file-id-or-url": "f1", "new-name": "N"},
		"move":    {"file-id-or-url": "f1", "folder-id-or-url": "root"},
		"trash":   {"file-id-or-url": "f1"},
		"share":   {"file-id-or-url": "f1"},
		"unshare": {"file-id-or-url": "f1"},
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", fresh("full"), true)
	fake := driveFake(t)
	_, writeArgs := writeInputs(t)
	ops := map[string]string{
		"put": "upload file", "copy": "copy file", "mkdir": "create folder", "rename": "rename file",
		"move": "move file", "trash": "trash file", "share": "share file", "unshare": "remove permission",
	}
	for path, op := range ops {
		in := product.Input(t, path, writeArgs[path], map[string]any{"anyone": true})
		v, err := product.Exec(fake.Ctx(), t, reg, path, in)
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio gdrive profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	out := filepath.Join(t.TempDir(), "out.bin")
	reads := map[string]plugins.CommandInput{
		"list":        product.Input(t, "list", nil, nil),
		"folders":     product.Input(t, "folders", nil, nil),
		"get":         product.Input(t, "get", map[string]any{"file-id-or-url": "f1"}, nil),
		"search":      product.Input(t, "search", nil, map[string]any{"query": "q"}),
		"download":    product.Input(t, "download", map[string]any{"file-id-or-url": "f1"}, map[string]any{"output": out}),
		"permissions": product.Input(t, "permissions", map[string]any{"file-id-or-url": "f1"}, nil),
	}
	for path, in := range reads {
		if _, err := product.Exec(fake.Ctx(), t, reg, path, in); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if b, _ := os.ReadFile(out); string(b) != "bytes" {
		t.Fatalf("download wrote %q", b)
	}
}

// A profile created with readonly access (or before access levels existed)
// is refused by the client before any request for put, copy, mkdir, rename
// and move. Bun's trash, share and unshare never check it.
func TestReadonlyAccessLevelRefusesBunsClientWrites(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "rol", fresh("readonly"), false)
	product.SaveProfile(t, "legacy", fresh(""), false)
	fake := driveFake(t)
	_, writeArgs := writeInputs(t)
	for _, name := range []string{"rol", "legacy"} {
		for _, path := range []string{"put", "copy", "mkdir", "rename", "move"} {
			in := product.Input(t, path, writeArgs[path], map[string]any{"profile": name})
			v, err := product.Exec(fake.Ctx(), t, reg, path, in)
			ce := googletest.CliErr(t, err)
			if v != nil || ce.Code != clierr.PermissionDenied || ce.Message != "This profile has read-only access" ||
				ce.Suggestion != "Create a new profile with full access: agentio gdrive profile add --full" {
				t.Fatalf("%s %s: %#v", name, path, ce)
			}
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	for _, path := range []string{"trash", "share", "unshare"} {
		in := product.Input(t, path, writeArgs[path], map[string]any{"profile": "rol", "anyone": true})
		if _, err := product.Exec(fake.Ctx(), t, reg, path, in); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
}

// Bun validates share and unshare flags before it looks at the profile, so a
// bad flag on a read-only profile is INVALID_PARAMS, not PERMISSION_DENIED.
func TestShareFlagErrorsWinOverTheReadOnlyCheck(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", fresh("full"), true)
	fake := driveFake(t)
	cases := []struct {
		path                string
		set                 map[string]any
		message, suggestion string
	}{
		{"share", nil, "Specify one of --anyone, --user, --domain, or --group", ""},
		{"share", map[string]any{"user": ""}, "Specify one of --anyone, --user, --domain, or --group", ""},
		{"share", map[string]any{"anyone": true, "user": "a@example.com"}, "--anyone, --user, --domain, and --group are mutually exclusive", ""},
		{"share", map[string]any{"domain": "example.com", "group": "g@example.com"}, "--anyone, --user, --domain, and --group are mutually exclusive", ""},
		{"share", map[string]any{"user": "a@example.com", "allow-discovery": true}, "--allow-discovery only applies with --anyone", ""},
		{"share", map[string]any{"anyone": true, "role": "owner"}, "Invalid role: owner", "Use reader, commenter, or writer"},
		{"share", map[string]any{"anyone": true, "role": ""}, "Invalid role: ", "Use reader, commenter, or writer"},
		{"unshare", nil, "Specify --permission-id or --anyone", ""},
		{"unshare", map[string]any{"permission-id": ""}, "Specify --permission-id or --anyone", ""},
		{"unshare", map[string]any{"permission-id": "p1", "anyone": true}, "--permission-id and --anyone are mutually exclusive", ""},
	}
	for _, c := range cases {
		set := map[string]any{"profile": "ro"}
		for k, v := range c.set {
			set[k] = v
		}
		v, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, map[string]any{"file-id-or-url": "f1"}, set))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%s %v: %#v", c.path, c.set, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("invalid input reached the API %d times", n)
	}
}

func TestValidate(t *testing.T) {
	var status int
	var body any
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path != "/files" || h.Auth != "Bearer at-old" || h.Query.Get("pageSize") != "1" || h.Query.Get("q") != "" {
			t.Errorf("validate called %s %v with %q", h.Path, h.Query, h.Auth)
		}
		googletest.WriteJSON(w, status, body)
	})
	run := host.NewRunContext(storedCreds(1, "full"), "acme", fake.Ctx())
	status, body = 200, map[string]any{"files": []any{}}
	v, err := New().Profile.Validate(fake.Ctx(), run)
	if err != nil || !v.Valid || v.Info != "me@example.com" {
		t.Fatalf("%#v %v", v, err)
	}
	status, body = 401, map[string]any{"error": map[string]any{"code": 401, "message": "Request had invalid authentication credentials."}}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); v.Valid || v.Error != "Request had invalid authentication credentials." {
		t.Fatalf("%#v", v)
	}
	status, body = 400, map[string]any{"error": map[string]any{"code": 400, "message": "Token has been expired or revoked."}}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); v.Valid || v.Error != "refresh token expired, re-authenticate" {
		t.Fatalf("%#v", v)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(5, "full")
	out := auth.RedactForRemote(reg, "gdrive", creds)
	if _, ok := out["refreshToken"]; ok || out["accessToken"] != "at-old" || out["accessLevel"] != "full" || out["expiryDate"] != int64(5) {
		t.Fatalf("%#v", out)
	}
	if creds["refreshToken"] != "rt-old" {
		t.Fatal("redaction changed the caller's map")
	}
}

func TestListInfo(t *testing.T) {
	for creds, want := range map[*map[string]any]string{
		{"email": "me@example.com", "accessLevel": "full"}:     " - me@example.com (full)",
		{"email": "me@example.com", "accessLevel": "readonly"}: " - me@example.com (read-only)",
		{"email": "me@example.com"}:                            " - me@example.com (read-only)",
		{}:                                                     " - undefined (read-only)",
	} {
		if got := listInfo(*creds); got != want {
			t.Errorf("%v: %q", *creds, got)
		}
	}
	if listInfo(nil) != "" {
		t.Fatal("a profile without credentials has no extra info")
	}
}

// Reauthentication keeps the stored access level (readonly when absent) and
// asks for that level's scopes.
func TestReauthenticateKeepsTheAccessLevel(t *testing.T) {
	for _, c := range []struct{ stored, level, scopes string }{
		{"full", "full", fullScopes},
		{"readonly", "readonly", readonlyScopes},
		{"", "readonly", readonlyScopes},
	} {
		fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
			if h.Path == "/token" {
				googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-2", "expires_in": 60})
				return
			}
			googletest.WriteJSON(w, 200, map[string]any{"email": "new@example.com"})
		})
		var scopes string
		var logs []string
		prev := storedCreds(1, c.stored)
		prev["extra"] = "kept"
		got, err := New().Profile.Reauthenticate(fake.Ctx(), prev, "work", oauthSetup(t, "", &scopes, &logs))
		if err != nil {
			t.Fatal(err)
		}
		// No refresh token in the response: Bun's spread of undefined drops the old one.
		if _, ok := got["refreshToken"]; ok || got["accessToken"] != "at-2" || got["email"] != "new@example.com" ||
			got["accessLevel"] != c.level || got["extra"] != "kept" || scopes != c.scopes {
			t.Fatalf("%q: %#v %q", c.stored, got, scopes)
		}
		if prev["refreshToken"] != "rt-old" {
			t.Fatal("reauthenticate changed the stored map")
		}
		if strings.Join(logs, "|") != "\nRe-authenticating gdrive / work...|  Done (new@example.com, "+c.level+")" {
			t.Fatalf("%q", logs)
		}
	}
}

// Bun pages with pageSize min(limit - collected, 100) until it has limit
// files or no next page, then slices to limit.
func TestListPagesUntilTheLimitWithBunsQueries(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("full"), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		start := 0
		if tok := h.Query.Get("pageToken"); tok != "" {
			start = int(tok[0] - '0')
		}
		var files []any
		for i := start; i < start+2 && i < 5; i++ {
			files = append(files, map[string]any{"id": string(rune('a' + i)), "name": "n", "mimeType": "text/plain"})
		}
		resp := map[string]any{"files": files}
		if start+2 < 5 {
			resp["nextPageToken"] = string(rune('0' + start + 2))
		}
		googletest.WriteJSON(w, 200, resp)
	})
	fields := "nextPageToken,files(" + fileFields + ")"
	cases := []struct {
		path      string
		set       map[string]any
		pageSizes string
		q, order  string
		ids       string
	}{
		{"list", map[string]any{"limit": "3"}, "3,1", "trashed = false", "modifiedTime desc", "a,b,c"},
		{"list", nil, "20,18,16", "trashed = false", "modifiedTime desc", "a,b,c,d,e"},
		{"list", map[string]any{"limit": "250"}, "100,100,100", "trashed = false", "modifiedTime desc", "a,b,c,d,e"},
		{"list", map[string]any{"limit": "abc"}, "NaN", "trashed = false", "modifiedTime desc", ""},
		{"list", map[string]any{"limit": "0"}, "0", "trashed = false", "modifiedTime desc", ""},
		{"list", map[string]any{"limit": "-1"}, "-1", "trashed = false", "modifiedTime desc", "a"},
		{"list", map[string]any{"limit": "2", "folder": "root", "query": "starred = true", "order": "name", "trash": true}, "2", "'root' in parents and starred = true", "name", "a,b"},
		{"folders", map[string]any{"limit": "1", "parent": "p1", "query": "name contains 'x'"}, "1",
			"trashed = false and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'p1' in parents and name contains 'x'", "name", "a"},
		{"search", map[string]any{"query": "it's", "limit": "1", "type": "application/pdf", "folder": "f9"}, "1",
			`trashed = false and trashed = false and fullText contains 'it\'s' and mimeType = 'application/pdf' and 'f9' in parents`, "modifiedTime desc", "a"},
	}
	for _, c := range cases {
		before := len(fake.Recorded())
		v, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, nil, c.set))
		if err != nil {
			t.Fatalf("%v: %v", c.set, err)
		}
		var sizes []string
		for _, h := range fake.Recorded()[before:] {
			if h.Method != "GET" || h.Path != "/files" || h.Query.Get("q") != c.q || h.Query.Get("orderBy") != c.order || h.Query.Get("fields") != fields {
				t.Fatalf("%s %v: %s %s %v", c.path, c.set, h.Method, h.Path, h.Query)
			}
			sizes = append(sizes, h.Query.Get("pageSize"))
		}
		var ids []string
		for _, f := range v.(fileList).Files {
			ids = append(ids, f.ID)
		}
		if strings.Join(sizes, ",") != c.pageSizes || strings.Join(ids, ",") != c.ids {
			t.Fatalf("%s %v: pageSizes %v ids %v", c.path, c.set, sizes, ids)
		}
	}
	// No filter at all sends no q.
	before := len(fake.Recorded())
	if _, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"trash": true, "limit": "1"})); err != nil {
		t.Fatal(err)
	}
	if h := fake.Recorded()[before]; h.Query.Has("q") {
		t.Fatalf("q %q", h.Query.Get("q"))
	}
	v, err := product.Exec(fake.Ctx(), t, reg, "search", product.Input(t, "search", nil, nil))
	ce := googletest.CliErr(t, err)
	if v != nil || ce.Code != clierr.InvalidParams || ce.Message != "required option '--query <text>' not specified" {
		t.Fatalf("%#v", ce)
	}
}

func TestIDsComeFromDriveURLs(t *testing.T) {
	for in, want := range map[string]string{
		"abc": "abc",
		"https://drive.google.com/file/d/F-1_x/view":   "F-1_x",
		"https://drive.google.com/drive/folders/D9":    "D9",
		"https://drive.google.com/open?id=Q1&usp=x":    "Q1",
		"https://docs.google.com/document/d/doc1/edit": "https://docs.google.com/document/d/doc1/edit",
	} {
		if got := extractFileID(in); got != want {
			t.Errorf("%s: %q", in, got)
		}
	}
	// share's printed id ignores /folders/ URLs, as Bun's command does.
	if printedFileID("https://drive.google.com/drive/folders/D9") != "https://drive.google.com/drive/folders/D9" ||
		printedFileID("https://drive.google.com/file/d/F1/view") != "F1" {
		t.Fatal("printed id")
	}
}

func TestDownloadWritesBytesAndExportsWorkspaceFiles(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("full"), false)
	meta := map[string]map[string]any{
		"pdf1":   {"id": "pdf1", "name": "report.pdf", "mimeType": "application/pdf"},
		"doc1":   {"id": "doc1", "name": "Plan", "mimeType": "application/vnd.google-apps.document"},
		"sheet1": {"id": "sheet1", "name": "Budget", "mimeType": "application/vnd.google-apps.spreadsheet"},
		"form1":  {"id": "form1", "name": "Survey", "mimeType": "application/vnd.google-apps.form"},
	}
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		id := strings.Split(strings.TrimPrefix(h.Path, "/files/"), "/")[0]
		switch {
		case strings.HasSuffix(h.Path, "/export"):
			_, _ = io.WriteString(w, "EXPORT:"+h.Query.Get("mimeType"))
		case h.Query.Get("alt") == "media":
			_, _ = io.WriteString(w, "BINARY")
		case id == "missing":
			googletest.WriteJSON(w, 404, map[string]any{"error": map[string]any{"code": 404, "message": "File not found: missing."}})
		default:
			googletest.WriteJSON(w, 200, meta[id])
		}
	})
	dir := t.TempDir()
	run := func(id, output, export string) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "download", product.Input(t, "download", map[string]any{"file-id-or-url": id}, map[string]any{"output": output, "export": export}))
	}
	out := filepath.Join(dir, "r.pdf")
	v, err := run("https://drive.google.com/file/d/pdf1/view", out, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Printed(t, "download", v, false); got != "Downloaded: report.pdf\n  Path: "+out+"\n  Size: 6 B\n  Type: application/pdf\n" {
		t.Fatalf("%q", got)
	}
	if b, _ := os.ReadFile(out); string(b) != "BINARY" {
		t.Fatalf("%q", b)
	}
	h := fake.Recorded()
	if h[0].Query.Get("fields") != fileFields || h[1].Path != "/files/pdf1" || h[1].Query.Get("alt") != "media" {
		t.Fatalf("%v %v", h[0].Query, h[1])
	}
	out = filepath.Join(dir, "s.csv")
	v, err = run("sheet1", out, "csv")
	if err != nil {
		t.Fatal(err)
	}
	if googletest.JSONText(v) != `{"filename":"Budget","path":"`+out+`","size":15,"mimeType":"text/csv"}` {
		t.Fatalf("%s", googletest.JSONText(v))
	}
	if b, _ := os.ReadFile(out); string(b) != "EXPORT:text/csv" {
		t.Fatalf("%q", b)
	}
	before := len(fake.Recorded())
	for _, c := range []struct {
		id, output, export  string
		code                clierr.Code
		message, suggestion string
	}{
		{"doc1", "x", "", clierr.InvalidParams, "Cannot download Google Doc directly", "Use --export with one of: pdf, docx, odt, txt, html, rtf"},
		{"doc1", "x", "xlsx", clierr.InvalidParams, "Cannot export Google Doc to xlsx", "Supported formats: pdf, docx, odt, txt, html, rtf"},
		{"sheet1", "x", "docx", clierr.InvalidParams, "Cannot export Google Sheet to docx", "Supported formats: xlsx, csv, pdf, ods, tsv"},
		{"form1", "x", "", clierr.InvalidParams, "Cannot download Google Form directly", "Use --export with one of: "},
		{"form1", "x", "pdf", clierr.InvalidParams, "Cannot export Google Form to pdf", "Supported formats: "},
		{"pdf1", "x", "pdf", clierr.InvalidParams, "Export format is only for Google Workspace files", "Remove --export flag for regular files"},
		{"missing", "x", "", clierr.NotFound, "Failed to get file: File not found: missing.", ""},
		{"pdf1", filepath.Join(dir, "nodir", "x"), "", "API_ERROR", "Failed to download file: ENOENT: no such file or directory, open '" + filepath.Join(dir, "nodir", "x") + "'", ""},
		{"pdf1", dir, "", "API_ERROR", "Failed to download file: EISDIR: illegal operation on a directory, open '" + dir + "'", ""},
		// A given "" passes Commander's requiredOption; Bun's writeFile('') fails.
		{"pdf1", "", "", "API_ERROR", "Failed to download file: ENOENT: no such file or directory, open", ""},
	} {
		v, err := run(c.id, c.output, c.export)
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%s %s: %#v", c.id, c.export, ce)
		}
	}
	// An absent --output is Commander's required-option error, before any request.
	requests := len(fake.Recorded())
	_, err = product.Exec(fake.Ctx(), t, reg, "download", product.Input(t, "download", map[string]any{"file-id-or-url": "pdf1"}, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "required option '--output <path>' not specified" || len(fake.Recorded()) != requests {
		t.Fatalf("%#v", ce)
	}
	for _, h := range fake.Recorded()[before:] {
		if strings.HasSuffix(h.Path, "/export") {
			t.Fatalf("an invalid export reached the API: %v", h)
		}
	}
}

func multipartParts(t *testing.T, h googletest.Hit) (map[string]any, string, string) {
	t.Helper()
	_, params, err := mime.ParseMediaType(h.Type)
	if err != nil {
		t.Fatalf("content type %q", h.Type)
	}
	r := multipart.NewReader(strings.NewReader(h.Raw), params["boundary"])
	meta, _ := r.NextPart()
	var m map[string]any
	_ = json.NewDecoder(meta).Decode(&m)
	media, _ := r.NextPart()
	body, _ := io.ReadAll(media)
	return m, media.Header.Get("Content-Type"), string(body)
}

func TestPutUploadsWithBunsMetadataAndConversion(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("full"), false)
	var respond map[string]any
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if strings.HasSuffix(h.Path, "/permissions") {
			googletest.WriteJSON(w, 403, map[string]any{"error": map[string]any{"code": 403, "message": "Sharing is disabled."}})
			return
		}
		googletest.WriteJSON(w, 200, respond)
	})
	dir := t.TempDir()
	file := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	put := func(path string, set map[string]any) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "put", product.Input(t, "put", map[string]any{"file-path": path}, set))
	}
	cases := []struct {
		path      string
		set       map[string]any
		meta      string
		mediaType string
	}{
		{file("a.txt", "hello"), nil, `{"name":"a.txt"}`, "text/plain"},
		{file("b.bin", "x"), map[string]any{"name": "N.txt", "folder": "fold1", "type": "text/html"}, `{"name":"N.txt","parents":["fold1"]}`, "text/html"},
		{file("Report.v2.DOCX", "d"), map[string]any{"convert": true}, `{"mimeType":"application/vnd.google-apps.document","name":"Report.v2"}`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
		{file("data.csv", "a,b"), map[string]any{"convert": true, "name": "sheet"}, `{"mimeType":"application/vnd.google-apps.spreadsheet","name":"sheet"}`, "text/csv"},
		{file(".bashrc", "rc"), nil, `{"name":".bashrc"}`, "application/octet-stream"},
	}
	for i, c := range cases {
		respond = map[string]any{"id": "up1", "name": "Server name", "mimeType": "text/plain", "webViewLink": "https://drive.google.com/file/d/up1/view"}
		if _, err := put(c.path, c.set); err != nil {
			t.Fatalf("%s: %v", c.path, err)
		}
		h := fake.Recorded()[i]
		if h.Method != "POST" || h.Path != "/upload/drive/v3/files" || h.Query.Get("uploadType") != "multipart" || h.Query.Get("fields") != "id,name,mimeType,size,webViewLink" {
			t.Fatalf("%s %s %v", h.Method, h.Path, h.Query)
		}
		meta, mediaType, _ := multipartParts(t, h)
		if googletest.JSONText(meta) != c.meta || mediaType != c.mediaType {
			t.Fatalf("%s: %v %q", c.path, meta, mediaType)
		}
	}
	// Missing response fields fall back to the local name and type; size is the local size.
	respond = map[string]any{"id": "up2"}
	v, err := put(file("x.odt", "12345678"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Printed(t, "put", v, false); got != "Uploaded: x.odt\n  ID: up2\n  Size: 8 B\n  Type: application/vnd.oasis.opendocument.text\n" {
		t.Fatalf("%q", got)
	}
	// --public prints the upload, then the failed share, as Bun did.
	respond = map[string]any{"id": "up3", "name": "p.png", "mimeType": "image/png"}
	v, err = put(file("p.png", "img"), map[string]any{"public": true})
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.PermissionDenied || ce.Message != "Failed to share file: Sharing is disabled." {
		t.Fatalf("%#v", ce)
	}
	if got := product.Printed(t, "put", v, false); got != "Uploaded: p.png\n  ID: up3\n  Size: 3 B\n  Type: image/png\n" {
		t.Fatalf("%q", got)
	}
	last := fake.Recorded()[len(fake.Recorded())-1]
	if last.Path != "/files/up3/permissions" || googletest.JSONText(last.JSON) != `{"allowFileDiscovery":false,"role":"reader","type":"anyone"}` ||
		last.Query.Get("sendNotificationEmail") != "false" || last.Query.Get("supportsAllDrives") != "true" {
		t.Fatalf("%v %v", last.JSON, last.Query)
	}
	before := len(fake.Recorded())
	missing := filepath.Join(dir, "missing.txt")
	for _, c := range []struct {
		path                string
		set                 map[string]any
		code                clierr.Code
		message, suggestion string
	}{
		{missing, nil, "API_ERROR", "Failed to upload file: ENOENT: no such file or directory, stat '" + missing + "'", ""},
		// stat comes before the conversion check.
		{missing, map[string]any{"convert": true}, "API_ERROR", "Failed to upload file: ENOENT: no such file or directory, stat '" + missing + "'", ""},
		{file("noext", "x"), map[string]any{"convert": true}, clierr.InvalidParams, "Cannot convert this file type to Google Workspace format", "Supported: docx, doc, odt, txt, html, rtf, xlsx, xls, ods, csv, tsv, pptx, ppt, odp"},
		{file("pic.PNG", "x"), map[string]any{"convert": true}, clierr.InvalidParams, "Cannot convert .png to Google Workspace format", "Supported: docx, doc, odt, txt, html, rtf, xlsx, xls, ods, csv, tsv, pptx, ppt, odp"},
		{dir, nil, "API_ERROR", "Failed to upload file: EISDIR: illegal operation on a directory, read", ""},
	} {
		v, err := put(c.path, c.set)
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%s: %#v", c.path, ce)
		}
	}
	if n := len(fake.Recorded()); n != before {
		t.Fatalf("a failed put reached the API %d times", n-before)
	}
}

func TestFileWritesSendBunsBodies(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("full"), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case h.Method == "GET" && h.Path == "/files/multi":
			googletest.WriteJSON(w, 200, map[string]any{"parents": []string{"p1", "p2"}})
		case h.Method == "GET":
			googletest.WriteJSON(w, 200, map[string]any{})
		case strings.HasSuffix(h.Path, "/copy"):
			googletest.WriteJSON(w, 200, map[string]any{"id": "c1", "parents": []string{"dest"}})
		default:
			googletest.WriteJSON(w, 200, map[string]any{"id": "r1", "name": "Result", "parents": []string{"dest"}, "webViewLink": "https://x/r1"})
		}
	})
	type want struct {
		method, path, body string
		query              map[string]string
	}
	cases := []struct {
		path    string
		args    map[string]any
		set     map[string]any
		sent    []want
		printed string
	}{
		{"copy", map[string]any{"file-id-or-url": "https://docs.google.com/document/d/x/edit?id=d1"}, nil,
			[]want{{"POST", "/files/d1/copy", `{}`, map[string]string{"supportsAllDrives": "true", "fields": "id,name,mimeType,parents,webViewLink"}}},
			"Copied: Untitled\n  ID: c1\n  Type: application/octet-stream\n  Folder: dest\n"},
		{"copy", map[string]any{"file-id-or-url": "d1"}, map[string]any{"name": "Draft", "folder": "dest"},
			[]want{{"POST", "/files/d1/copy", `{"name":"Draft","parents":["dest"]}`, nil}}, ""},
		{"mkdir", map[string]any{"name": "Reports"}, nil,
			[]want{{"POST", "/files", `{"mimeType":"application/vnd.google-apps.folder","name":"Reports"}`, map[string]string{"supportsAllDrives": "true", "fields": fileFields}}},
			"Created folder: Result (r1)\n  Link: https://x/r1\n"},
		{"mkdir", map[string]any{"name": ""}, map[string]any{"parent": "https://drive.google.com/drive/folders/P1"},
			[]want{{"POST", "/files", `{"mimeType":"application/vnd.google-apps.folder","name":"","parents":["P1"]}`, nil}}, ""},
		{"rename", map[string]any{"file-id-or-url": "https://drive.google.com/drive/folders/F1", "new-name": ""}, nil,
			[]want{{"PATCH", "/files/F1", `{"name":""}`, map[string]string{"supportsAllDrives": "true", "fields": fileFields}}},
			"Renamed: Result (r1)\n"},
		{"trash", map[string]any{"file-id-or-url": "t1"}, nil,
			[]want{{"PATCH", "/files/t1", `{"trashed":true}`, map[string]string{"supportsAllDrives": "true"}}},
			"Trashed: Result (r1)\n"},
		{"move", map[string]any{"file-id-or-url": "multi", "folder-id-or-url": "https://drive.google.com/drive/folders/dest"}, nil,
			[]want{
				{"GET", "/files/multi", "", map[string]string{"supportsAllDrives": "true", "fields": "parents"}},
				{"PATCH", "/files/multi", `{}`, map[string]string{"addParents": "dest", "removeParents": "p1,p2", "supportsAllDrives": "true", "fields": fileFields}},
			}, "Moved: Result (r1)\n  Folder: dest\n"},
		{"move", map[string]any{"file-id-or-url": "orphan", "folder-id-or-url": "root"}, nil,
			[]want{{"GET", "/files/orphan", "", nil}, {"PATCH", "/files/orphan", `{}`, map[string]string{"addParents": "root", "removeParents": ""}}}, ""},
	}
	for _, c := range cases {
		before := len(fake.Recorded())
		v, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, c.args, c.set))
		if err != nil {
			t.Fatalf("%s: %v", c.path, err)
		}
		got := fake.Recorded()[before:]
		if len(got) != len(c.sent) {
			t.Fatalf("%s: %d requests", c.path, len(got))
		}
		for i, w := range c.sent {
			h := got[i]
			body := ""
			if h.JSON != nil {
				body = googletest.JSONText(h.JSON)
			}
			if h.Method != w.method || h.Path != w.path || body != w.body {
				t.Fatalf("%s: %s %s %s", c.path, h.Method, h.Path, body)
			}
			for k, v := range w.query {
				if h.Query.Get(k) != v {
					t.Fatalf("%s: %s=%q", c.path, k, h.Query.Get(k))
				}
			}
		}
		if c.printed != "" {
			if p := product.Printed(t, c.path, v, false); p != c.printed {
				t.Fatalf("%s: %q", c.path, p)
			}
		}
	}
}

// Ported from tests/plugins/google/gdrive/client.test.ts: allowFileDiscovery
// is only sent for anyone shares.
func TestShareSendsBunsPermissionBody(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("full"), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		resp := map[string]any{"id": "perm-1", "type": h.JSON["type"], "role": h.JSON["role"]}
		for _, k := range []string{"emailAddress", "domain"} {
			if v, ok := h.JSON[k]; ok {
				resp[k] = v
			}
		}
		googletest.WriteJSON(w, 200, resp)
	})
	cases := []struct {
		arg     string
		set     map[string]any
		body    string
		query   map[string]string
		printed string
	}{
		{"f1", map[string]any{"user": "a@example.com", "role": "writer", "allow-discovery": false},
			`{"emailAddress":"a@example.com","role":"writer","type":"user"}`, map[string]string{"sendNotificationEmail": "false"},
			"Permission created\n  Permission ID: perm-1\n  Type: user\n  Role: writer\n  Email: a@example.com\n"},
		{"f1", map[string]any{"anyone": true, "allow-discovery": true},
			`{"allowFileDiscovery":true,"role":"reader","type":"anyone"}`, nil,
			"Permission created\n  Permission ID: perm-1\n  Type: anyone\n  Role: reader\n  Public URL: https://drive.google.com/uc?id=f1\n"},
		{"https://drive.google.com/drive/folders/D1", map[string]any{"anyone": true},
			`{"allowFileDiscovery":false,"role":"reader","type":"anyone"}`, nil,
			"Permission created\n  Permission ID: perm-1\n  Type: anyone\n  Role: reader\n  Public URL: https://drive.google.com/uc?id=https://drive.google.com/drive/folders/D1\n"},
		{"f1", map[string]any{"group": "g@example.com", "notify": true, "message": "hi"},
			`{"emailAddress":"g@example.com","role":"reader","type":"group"}`, map[string]string{"sendNotificationEmail": "true", "emailMessage": "hi"}, ""},
		// googleapis sends a given --message "" as `emailMessage=`.
		{"f1", map[string]any{"user": "a@example.com", "notify": true, "message": ""},
			`{"emailAddress":"a@example.com","role":"reader","type":"user"}`, map[string]string{"sendNotificationEmail": "true", "emailMessage": ""}, ""},
		{"f1", map[string]any{"domain": "example.com", "role": "commenter", "message": "ignored"},
			`{"domain":"example.com","role":"commenter","type":"domain"}`, map[string]string{"sendNotificationEmail": "false", "emailMessage": "ignored"},
			"Permission created\n  Permission ID: perm-1\n  Type: domain\n  Role: commenter\n  Domain: example.com\n"},
	}
	for _, c := range cases {
		before := len(fake.Recorded())
		v, err := product.Exec(fake.Ctx(), t, reg, "share", product.Input(t, "share", map[string]any{"file-id-or-url": c.arg}, c.set))
		if err != nil {
			t.Fatal(err)
		}
		h := fake.Recorded()[before]
		if h.Method != "POST" || h.Path != "/files/"+extractFileID(c.arg)+"/permissions" || googletest.JSONText(h.JSON) != c.body ||
			h.Query.Get("supportsAllDrives") != "true" || h.Query.Get("fields") != "id,type,role,emailAddress,domain" {
			t.Fatalf("%v: %s %s %s %v", c.set, h.Method, h.Path, googletest.JSONText(h.JSON), h.Query)
		}
		for k, want := range c.query {
			if !h.Query.Has(k) || h.Query.Get(k) != want {
				t.Fatalf("%v: %s=%q", c.set, k, h.Query.Get(k))
			}
		}
		if c.query == nil && h.Query.Has("emailMessage") {
			t.Fatal("an empty message was sent")
		}
		if c.printed != "" {
			if got := product.Printed(t, "share", v, false); got != c.printed {
				t.Fatalf("%q", got)
			}
		}
	}
}

func TestUnshareFindsTheAnyonePermission(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("full"), false)
	perms := map[string][]any{
		"f1": {map[string]any{"id": "u1", "type": "user", "role": "owner"}, map[string]any{"id": "anyoneWithLink", "type": "anyone", "role": "reader"}},
		"f2": {map[string]any{"id": "u1", "type": "user", "role": "owner"}},
	}
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"permissions": perms[strings.Split(h.Path, "/")[2]]})
	})
	unshare := func(id string, set map[string]any) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "unshare", product.Input(t, "unshare", map[string]any{"file-id-or-url": id}, set))
	}
	v, err := unshare("https://drive.google.com/file/d/f1/view", map[string]any{"anyone": true})
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()
	if len(h) != 2 || h[0].Path != "/files/f1/permissions" || h[1].Method != "DELETE" || h[1].Path != "/files/f1/permissions/anyoneWithLink" ||
		h[1].Query.Get("supportsAllDrives") != "true" {
		t.Fatalf("%v", h)
	}
	if got := product.Printed(t, "unshare", v, false); got != "Permission anyoneWithLink removed\n" {
		t.Fatalf("%q", got)
	}
	if _, err := unshare("f2", map[string]any{"permission-id": "u1"}); err != nil {
		t.Fatal(err)
	}
	if last := fake.Recorded()[2]; last.Method != "DELETE" || last.Path != "/files/f2/permissions/u1" {
		t.Fatalf("%v", last)
	}
	v, err = unshare("f2", map[string]any{"anyone": true})
	ce := googletest.CliErr(t, err)
	if v != nil || ce.Code != clierr.NotFound || ce.Message != "No anyone-with-link permission found on this file" {
		t.Fatalf("%#v", ce)
	}
	if n := len(fake.Recorded()); n != 4 {
		t.Fatalf("a missing permission was deleted: %d requests", n)
	}
}

// gdrive prefers the API's own message; the fixed status text is only the
// fallback for a blank one.
func TestAPIErrorsPreferTheAPIMessage(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("full"), false)
	var status int
	var message string
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": message}})
	})
	cmds := []struct {
		path, operation string
		args, set       map[string]any
	}{
		{"list", "list files", nil, nil},
		{"folders", "list files", nil, nil},
		{"search", "list files", nil, map[string]any{"query": "q"}},
		{"get", "get file", map[string]any{"file-id-or-url": "f1"}, nil},
		{"download", "get file", map[string]any{"file-id-or-url": "f1"}, map[string]any{"output": "x"}},
		{"copy", "copy file", map[string]any{"file-id-or-url": "f1"}, nil},
		{"mkdir", "create folder", map[string]any{"name": "n"}, nil},
		{"rename", "rename file", map[string]any{"file-id-or-url": "f1", "new-name": "n"}, nil},
		{"move", "move file", map[string]any{"file-id-or-url": "f1", "folder-id-or-url": "f2"}, nil},
		{"trash", "trash file", map[string]any{"file-id-or-url": "f1"}, nil},
		{"permissions", "list permissions", map[string]any{"file-id-or-url": "f1"}, nil},
		{"share", "share file", map[string]any{"file-id-or-url": "f1"}, map[string]any{"anyone": true}},
		{"unshare", "list permissions", map[string]any{"file-id-or-url": "f1"}, map[string]any{"anyone": true}},
		{"unshare", "remove permission", map[string]any{"file-id-or-url": "f1"}, map[string]any{"permission-id": "p1"}},
	}
	for _, c := range []struct {
		status  int
		message string
		code    clierr.Code
		want    string
	}{
		{404, "File not found: f1.", clierr.NotFound, "File not found: f1."},
		{403, "The user does not have sufficient permissions for this file.", clierr.PermissionDenied, "The user does not have sufficient permissions for this file."},
		{401, "", clierr.AuthFailed, "OAuth token expired or invalid"},
		{403, " ", clierr.PermissionDenied, "Insufficient permissions to access this file"},
		{404, "", clierr.NotFound, "File not found"},
		{400, "Invalid Value", "API_ERROR", "Invalid Value"},
	} {
		status, message = c.status, c.message
		for _, cmd := range cmds {
			v, err := product.Exec(fake.Ctx(), t, reg, cmd.path, product.Input(t, cmd.path, cmd.args, cmd.set))
			ce := googletest.CliErr(t, err)
			if v != nil || ce.Code != c.code || ce.Message != "Failed to "+cmd.operation+": "+c.want || ce.Suggestion != "" {
				t.Fatalf("%d %q %s: %v %#v", c.status, c.message, cmd.path, v, ce)
			}
		}
	}
}

// Expected text is what the Bun CLI printed against the same fixtures.
func TestFormatMatchesBun(t *testing.T) {
	list := fileList{Title: "Files", Files: []file{
		{ID: "doc1", Name: "Quarterly Plan", MimeType: "application/vnd.google-apps.document", ModifiedTime: "2026-03-04T05:06:07.000Z", Starred: true, Shared: true},
		{ID: "pdf1", Name: "report <final>.pdf", MimeType: "application/pdf", Size: 1536, ModifiedTime: "2026-02-01T00:00:00.000Z"},
		{ID: "fold1", Name: "Archive", MimeType: "application/vnd.google-apps.folder", ModifiedTime: "2025-12-31T23:59:59.000Z"},
		{ID: "sheet1", Name: "Budget", MimeType: "application/vnd.google-apps.spreadsheet"},
		{ID: "img1", Name: "Untitled", MimeType: "image/gif", Size: 5368709120},
		{ID: "vid1", Name: "clip.mov", MimeType: "video/quicktime", Size: 1048576, Starred: true},
	}}
	wantList := "Files (6)\n\n" +
		"gdoc           -  2026-03-04  *⇄ Quarterly Plan\n  doc1\n" +
		"pdf       1.5 KB  2026-02-01     report <final>.pdf\n  pdf1\n" +
		"folder         -  2025-12-31     Archive/\n  fold1\n" +
		"gsheet         -                 Budget\n  sheet1\n" +
		"image       5 GB                 Untitled\n  img1\n" +
		"video       1 MB              *  clip.mov\n  vid1\n"
	if got := product.Printed(t, "list", list, false); got != wantList {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "search", fileList{Title: "Search Results"}, false); got != "No files found\n" {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "folders", list, true); !strings.HasPrefix(got, "[\n  {\n    \"id\": \"doc1\"") || !strings.Contains(got, `"report <final>.pdf"`) {
		t.Fatalf("%q", got)
	}
	if shortMimeType("text/markdown") != "text" || shortMimeType("audio/mpeg") != "audio" || shortMimeType("application/json") != "file" || shortMimeType("image/jpeg") != "jpg" {
		t.Fatal("short mime types")
	}

	pdf := &file{ID: "pdf1", Name: "report <final>.pdf", MimeType: "application/pdf", Size: 1536, ModifiedTime: "2026-02-01T00:00:00.000Z",
		Owners: []string{"bob@example.com", "Unknown"}, Parents: []string{"fold1", "fold2"}, WebViewLink: "https://drive.google.com/file/d/pdf1/view",
		WebContentLink: "https://drive.google.com/uc?id=pdf1&export=download", Description: "Café & co"}
	wantFile := "ID: pdf1\nName: report <final>.pdf\nType: application/pdf\nSize: 1.5 KB\nDescription: Café & co\nOwners: bob@example.com, Unknown\n" +
		"Parents: fold1, fold2\nStarred: no\nShared: no\nTrashed: no\nModified: 2026-02-01T00:00:00.000Z\nView: https://drive.google.com/file/d/pdf1/view\n" +
		"Download: https://drive.google.com/uc?id=pdf1&export=download\n"
	if got := product.Printed(t, "get", pdf, false); got != wantFile {
		t.Fatalf("%q", got)
	}

	perms := []permission{
		{ID: "p-owner", Type: "user", Role: "owner", EmailAddress: "alice@example.com", DisplayName: "Alice"},
		{ID: "anyoneWithLink", Type: "anyone", Role: "reader", AllowFileDiscovery: true},
		{ID: "p-dom", Type: "domain", Role: "commenter", Domain: "example.com"},
		{ID: "p-grp", Type: "group", Role: "writer"},
	}
	wantPerms := "Permissions (4)\n\n  owner      alice@example.com\n    ID: p-owner\n    Name: Alice\n  reader     anyone (discoverable)\n" +
		"    ID: anyoneWithLink\n  commenter  example.com\n    ID: p-dom\n  writer     group\n    ID: p-grp\n"
	if got := product.Printed(t, "permissions", perms, false); got != wantPerms {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "permissions", []permission{}, false); got != "No permissions found\n" {
		t.Fatalf("%q", got)
	}

	up := &uploaded{ID: "up1", Name: "a.txt", MimeType: "text/plain", Size: 5, WebViewLink: "https://drive.google.com/file/d/up1/view",
		Share: &shared{PermissionID: "perm-new", Type: "anyone", Role: "reader", FileID: "up1"}}
	if got := product.Printed(t, "put", up, false); got != "Uploaded: a.txt\n  ID: up1\n  Size: 5 B\n  Type: text/plain\n  Link: https://drive.google.com/file/d/up1/view\n"+
		"Permission created\n  Permission ID: perm-new\n  Type: anyone\n  Role: reader\n  Public URL: https://drive.google.com/uc?id=up1\n" {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "put", up, true); !strings.Contains(got, `"share": {`) || strings.Contains(got, "FileID") || strings.Contains(got, "fileId") {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "mkdir", &file{ID: "new1", Name: "nolink"}, false); got != "Created folder: nolink (new1)\n" {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "move", &file{ID: "pdf1", Name: "report <final>.pdf"}, false); got != "Moved: report <final>.pdf (pdf1)\n" {
		t.Fatalf("%q", got)
	}
}

// Commander treats --query "" as present: Bun searches fullText for an empty string
// (list() adds its own "trashed = false" in front, as for any query).
func TestEmptySearchQueryIsSent(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh("readonly"), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"files": []any{}})
	})
	if _, err := product.Exec(fake.Ctx(), t, reg, "search", product.Input(t, "search", nil, map[string]any{"query": ""})); err != nil {
		t.Fatal(err)
	}
	if q := fake.Last().Query.Get("q"); q != "trashed = false and trashed = false and fullText contains ''" {
		t.Fatalf("%q", q)
	}
}
