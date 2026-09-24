package gscript

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
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

// storedCreds is a Bun GScriptCredentials object (camelCase keys).
func storedCreds(expiry int64) map[string]any {
	return map[string]any{
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"tokenType":    "Bearer",
		"scope":        "https://www.googleapis.com/auth/script.projects",
		"email":        "me@example.com",
	}
}

func fresh() map[string]any { return storedCreds(time.Now().Add(time.Hour).UnixMilli()) }

// The command table is the Bun surface: `bun run src/index.ts gscript --help`
// and each leaf's --help.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op, input string
		format, accessFor, verbatim    bool
	}
	want := map[string]row{
		"create":   {"", "--title <title> --parent <containerId>", "write", "create script project", "", true, true, false},
		"metadata": {"<id>", "", "read", "", "", true, false, false},
		"list":     {"", "--parent <containerId> --limit <n>=25", "read", "", "", true, false, false},
		"delete":   {"<id>", "--force", "write", "delete script project", "", false, false, false},
		"pull":     {"<id> [dir]", "--force", "read", "", "", true, false, false},
		"push":     {"[dir]", "--id <scriptId>", "write", "push script content", "", true, true, false},
		"get":      {"<id> <file>", "", "read", "", "", true, false, true},
		"put":      {"<id> <file>", "--source <text> --from <path>", "write", "update script content", "text", true, true, false},
	}
	p := New()
	if p.ID != "gscript" || p.DisplayName != "Google Apps Script" || p.Description != "Use when interacting with Google Apps Script via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, " ") != "create metadata list delete pull push get put" {
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
			f := o.Flags
			if d, ok := o.DefaultValue.(string); ok {
				f += "=" + d
			}
			flags = append(flags, f)
		}
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input, c.Format != nil, c.AccessFor != nil, c.Verbatim}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || len(c.Aliases) != 0 {
			t.Errorf("%s: examples %d aliases %v", c.Path, len(c.Examples), c.Aliases)
		}
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken" {
		t.Fatal("gscript is a camelCase Google lifecycle")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/script.projects"})
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
	var opts plugins.OAuthSetupOptions
	var logs []string
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) { logs = append(logs, parts[0].(string)) }
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:3001/callback"}, nil
	}
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	if err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if opts.Port != 0 || opts.ServiceName != "Google" {
		t.Fatalf("oauth opts %#v", opts)
	}
	authURL, _ := url.Parse(opts.AuthorizationURL("http://localhost:3001/callback"))
	q := authURL.Query()
	wantScope := "https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email"
	if authURL.Host != "accounts.google.com" || q.Get("scope") != wantScope || q.Get("access_type") != "offline" || q.Get("prompt") != "consent" {
		t.Fatalf("authorize url %s", authURL)
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
	// camelCase, as GScriptCredentials: a snake_case key would not open a Bun vault.
	if strings.Join(keys, ",") != "accessToken,email,expiryDate,refreshToken,scope,tokenType" {
		t.Fatalf("keys %v", keys)
	}
	if stored["accessToken"] != "at-1" || stored["refreshToken"] != "rt-1" || stored["email"] != "user@example.com" || stored["tokenType"] != "Bearer" {
		t.Fatalf("%#v", stored)
	}
	exp, ok := stored["expiryDate"].(json.Number)
	if !ok {
		t.Fatalf("expiryDate is %T, want a JSON number", stored["expiryDate"])
	}
	if n, _ := exp.Int64(); n < before+3599_000 || n > time.Now().UnixMilli()+3599_000 {
		t.Fatalf("expiry %d", n)
	}
	if out.String() != "Profile \"user@example.com\" configured!\nEmail: user@example.com\nTest with: agentio gscript list\n" {
		t.Fatalf("%q", out.String())
	}
	if len(logs) == 0 || logs[0] != "Starting OAuth flow for Google Apps Script...\n" {
		t.Fatalf("%q", logs)
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
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:3000/callback"}, nil
	}
	err := host.AddProfile(fake.Ctx(), New(), plugins.SetupOptions{}, sc, io.Discard)
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.AuthFailed || ce.Message != "Failed to fetch user email: No email returned from userinfo endpoint" || ce.Suggestion != "Ensure the account has an email address" {
		t.Fatalf("%#v", ce)
	}
	if c, _ := vault.Load(); len(c.Credentials["gscript"]) != 0 {
		t.Fatal("a failed setup saved a profile")
	}
}

// Bun never rotates a Google refresh token: a rotated one in the response is dropped.
func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := product.SetupVault(t)
	creds := storedCreds(1)
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
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gscript", "acme", auth.RefreshOptions{})
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
		stored["legacy"] != "kept" || stored["scope"] != "https://www.googleapis.com/auth/script.projects" {
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
	product.SaveProfile(t, "acme", storedCreds(1), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 400, map[string]any{"error": "invalid_grant", "error_description": "Token has been expired or revoked."})
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"id": "s1"}, nil))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gscript profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gscript profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

// content is a projects.getContent reply: a file without a trailing newline
// and one the API returns without a type.
const content = `{"scriptId":"s1","files":[` +
	`{"name":"Code","type":"SERVER_JS","source":"function main() {}\n","functionSet":{"values":[{"name":"main"}]}},` +
	`{"name":"appsscript","type":"JSON","source":"{\"timeZone\":\"Europe/Paris\"}"},` +
	`{"name":"Index","type":"HTML","source":"<p>héllo</p>"},` +
	`{"name":"Untyped","source":"var x = 1;"}]}`

// scriptFake answers the Script and Drive calls the commands make; reply
// overrides a "METHOD path". updateContent echoes the files it was sent.
func scriptFake(t *testing.T, reply map[string]string) *googletest.Fake {
	return googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if body, ok := reply[h.Method+" "+h.Path]; ok {
			googletest.WriteRaw(w, 200, body)
			return
		}
		switch {
		case h.Method == "GET" && strings.HasSuffix(h.Path, "/content"):
			googletest.WriteRaw(w, 200, content)
		case h.Method == "PUT" && strings.HasSuffix(h.Path, "/content"):
			googletest.WriteJSON(w, 200, map[string]any{"scriptId": "s1", "files": h.JSON["files"]})
		case h.Method == "GET" && strings.HasPrefix(h.Path, "/v1/projects/"):
			googletest.WriteRaw(w, 200, `{"scriptId":"s1","title":"Helper"}`)
		case h.Method == "POST" && h.Path == "/v1/projects":
			googletest.WriteRaw(w, 200, `{"scriptId":"new1","title":"Helper"}`)
		case h.Path == "/files":
			googletest.WriteJSON(w, 200, map[string]any{"files": []any{}})
		case h.Method == "DELETE":
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected %s %s", h.Method, h.Path)
			w.WriteHeader(500)
		}
	})
}

// scriptDir writes a push directory: .clasp.json naming scriptID (none when
// empty) and the given files.
func scriptDir(t *testing.T, scriptID string, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	if scriptID != "" {
		if err := os.WriteFile(filepath.Join(dir, ".clasp.json"), []byte(`{"scriptId":"`+scriptID+`","rootDir":"."}`), 0o666); err != nil {
			t.Fatal(err)
		}
	}
	for name, source := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(source), 0o666); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", fresh(), true)
	fake := scriptFake(t, nil)
	dir := scriptDir(t, "s1", map[string]string{"appsscript.json": "{}"})
	args := map[string]any{"id": "s1", "file": "Code", "dir": dir}
	writes := map[string]string{
		"create": "create script project", "delete": "delete script project",
		"push": "push script content", "put": "update script content",
	}
	for path, op := range writes {
		v, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, args, map[string]any{"title": "T", "force": true, "source": "x"}))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio gscript profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	// Bun checks create's required --title before enforceWriteAccess.
	_, err := product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", nil, map[string]any{"parent": "P1"}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "required option '--title <title>' not specified" || ce.Suggestion != "" {
		t.Fatalf("%#v", ce)
	}
	// Bun checks the push and put input before enforceWriteAccess.
	_, err = product.Exec(fake.Ctx(), t, reg, "put", product.Input(t, "put", args, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "No content provided" {
		t.Fatalf("%#v", ce)
	}
	_, err = product.Exec(fake.Ctx(), t, reg, "push", product.Input(t, "push", map[string]any{"dir": scriptDir(t, "", nil)}, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || !strings.HasPrefix(ce.Message, "No .clasp.json found in ") {
		t.Fatalf("%#v", ce)
	}
	pullDir := filepath.Join(t.TempDir(), "pulled")
	for _, path := range []string{"metadata", "list", "get", "pull"} {
		if _, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, map[string]any{"id": "s1", "file": "Code", "dir": pullDir}, nil)); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if n := len(fake.Recorded()); n != 4 {
		t.Fatalf("reads did not run: %d", n)
	}
}

func TestValidate(t *testing.T) {
	var status int
	var body any
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path != "/files" || h.Auth != "Bearer at-old" || h.Query.Get("pageSize") != "1" ||
			h.Query.Get("q") != "mimeType='application/vnd.google-apps.script'" {
			t.Errorf("validate called %s %v with %q", h.Path, h.Query, h.Auth)
		}
		googletest.WriteJSON(w, status, body)
	})
	run := host.NewRunContext(storedCreds(1), "acme", fake.Ctx())
	status, body = 200, map[string]any{"files": []any{}}
	v, err := New().Profile.Validate(fake.Ctx(), run)
	if err != nil || !v.Valid || v.Info != "me@example.com" {
		t.Fatalf("%#v %v", v, err)
	}
	status, body = 401, map[string]any{"error": map[string]any{"code": 401, "message": "Request had invalid authentication credentials."}}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); v.Valid || v.Error != "Request had invalid authentication credentials." {
		t.Fatalf("%#v", v)
	}
	status, body = 400, map[string]any{"error": map[string]any{"code": 400, "message": "invalid_grant"}}
	if v, _ := New().Profile.Validate(fake.Ctx(), run); v.Valid || v.Error != "refresh token expired, re-authenticate" {
		t.Fatalf("%#v", v)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(5)
	out := auth.RedactForRemote(reg, "gscript", creds)
	if _, ok := out["refreshToken"]; ok || out["accessToken"] != "at-old" || out["email"] != "me@example.com" || out["expiryDate"] != int64(5) {
		t.Fatalf("%#v", out)
	}
	if creds["refreshToken"] != "rt-old" {
		t.Fatal("redaction changed the caller's map")
	}
}

func TestListInfoAndReauthenticate(t *testing.T) {
	p := New()
	if p.Profile.ListInfo(map[string]any{"email": "me@example.com"}) != " - me@example.com" || p.Profile.ListInfo(map[string]any{}) != "" {
		t.Fatal("list info")
	}
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if h.Path == "/token" {
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		googletest.WriteJSON(w, 200, map[string]any{"email": "me@example.com"})
	})
	var logs []string
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	sc.Log = func(parts ...any) { logs = append(logs, parts[0].(string)) }
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		if !strings.Contains(o.AuthorizationURL("http://localhost:3000/callback"), "auth%2Fscript.projects") {
			t.Error("reauthenticate did not ask for the gscript scopes")
		}
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:3000/callback"}, nil
	}
	got, err := p.Profile.Reauthenticate(fake.Ctx(), storedCreds(1), "work", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["accessToken"] != "at-2" || got["refreshToken"] != "rt-2" || got["email"] != "me@example.com" {
		t.Fatalf("%#v", got)
	}
	if _, ok := got["access_token"]; ok {
		t.Fatalf("snake_case key %#v", got)
	}
	if strings.Join(logs, "|") != "\nRe-authenticating gscript / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

func TestListSendsTheBunQueryAndFormats(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"files": []any{
			map[string]any{"id": "s1", "name": "Helper", "parents": []any{"sheet9", "other"}, "modifiedTime": "2024-02-01T00:00:00.000Z"},
			map[string]any{"id": "s2"},
		}})
	})
	v, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"limit": "250", "parent": "sheet9"}))
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Path != "/files" || h.Query.Get("pageSize") != "100" || h.Query.Get("q") != "mimeType='application/vnd.google-apps.script' and trashed=false and 'sheet9' in parents" ||
		h.Query.Get("fields") != "files(id,name,parents,modifiedTime)" || h.Query.Get("orderBy") != "modifiedTime desc" {
		t.Fatalf("%s %v", h.Path, h.Query)
	}
	want := "Script projects (2)\n\n[1] Helper  [bound to sheet9]\n    ID: s1\n    Modified: 2024-02-01T00:00:00.000Z\n\n[2] Untitled\n    ID: s2\n\n"
	if got := product.Printed(t, "list", v, false); got != want {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(v); got != `[{"scriptId":"s1","title":"Helper","parentId":"sheet9","modifiedTime":"2024-02-01T00:00:00.000Z"},{"scriptId":"s2","title":"Untitled"}]` {
		t.Fatal(got)
	}
	if got := product.Printed(t, "list", []listItem{}, false); got != "No script projects found\n" {
		t.Fatalf("%q", got)
	}
	// The default is 25; parseInt("abc") is NaN, which gaxios sends as is.
	for limit, want := range map[string]string{"25": "25", "abc": "NaN", "7.9": "7"} {
		if _, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"limit": limit})); err != nil {
			t.Fatal(err)
		}
		all := fake.Recorded()
		if last := all[len(all)-1].Query; last.Get("pageSize") != want || strings.Contains(last.Get("q"), "parents") {
			t.Fatalf("%s: %v", limit, last)
		}
	}
}

func TestCreateAndMetadataPrintTheProject(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	full := `{"scriptId":"s1","title":"Helper","parentId":"sheet9","createTime":"2024-01-02T03:04:05Z","updateTime":"2024-02-03T04:05:06Z",` +
		`"creator":{"email":"owner@example.com","name":"Owner"},"lastModifyUser":{"email":"editor@example.com"}}`
	fake := scriptFake(t, map[string]string{"GET /v1/projects/s1": full, "GET /v1/projects/bare": `{"scriptId":"bare"}`})
	v, err := product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"id": "s1"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	want := "Script ID: s1\nTitle: Helper\nBound to: sheet9\nCreated: 2024-01-02T03:04:05Z\nUpdated: 2024-02-03T04:05:06Z\n" +
		"Creator: owner@example.com\nLast modified by: editor@example.com\nURL: https://script.google.com/d/s1/edit\n"
	if got := product.Printed(t, "metadata", v, false); got != want {
		t.Fatalf("%q", got)
	}
	v, _ = product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"id": "bare"}, nil))
	if got := product.Printed(t, "metadata", v, false); got != "Script ID: bare\nTitle: Untitled\nURL: https://script.google.com/d/bare/edit\n" {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(v); got != `{"scriptId":"bare","title":"Untitled","url":"https://script.google.com/d/bare/edit"}` {
		t.Fatal(got)
	}

	if _, err := product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", nil, map[string]any{"title": "Helper"})); err != nil {
		t.Fatal(err)
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", nil, map[string]any{"title": "Bound", "parent": "sheet9"})); err != nil {
		t.Fatal(err)
	}
	var bodies []string
	for _, h := range fake.Recorded() {
		if h.Method == "POST" {
			bodies = append(bodies, strings.TrimSpace(h.Raw))
		}
	}
	if strings.Join(bodies, "|") != `{"title":"Helper"}|{"parentId":"sheet9","title":"Bound"}` {
		t.Fatalf("%q", bodies)
	}
	before := len(fake.Recorded())
	_, err = product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", nil, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "required option '--title <title>' not specified" || len(fake.Recorded()) != before {
		t.Fatalf("%#v", ce)
	}
}

func TestDeleteNeedsForce(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := scriptFake(t, nil)
	v, err := product.Exec(fake.Ctx(), t, reg, "delete", product.Input(t, "delete", map[string]any{"id": "s1"}, nil))
	if err != nil || v != nil {
		t.Fatalf("%v %v", v, err)
	}
	if hits := fake.Recorded(); len(hits) != 1 || hits[0].Method != "GET" || hits[0].Path != "/v1/projects/s1" {
		t.Fatalf("without --force only the metadata is read: %+v", hits)
	}
	if got := product.Printed(t, "delete", v, false); got != "" {
		t.Fatalf("%q", got)
	}
	v, err = product.Exec(fake.Ctx(), t, reg, "delete", product.Input(t, "delete", map[string]any{"id": "s1"}, map[string]any{"force": true}))
	if err != nil {
		t.Fatal(err)
	}
	if hits := fake.Recorded(); hits[1].Method != "DELETE" || hits[1].Path != "/files/s1" {
		t.Fatalf("%+v", hits[1])
	}
	if got := product.Printed(t, "delete", v, false); got != "Deleted script project s1\n" {
		t.Fatalf("%q", got)
	}
}

func TestPullWritesTheFilesAndClasp(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := scriptFake(t, nil)
	dir := filepath.Join(t.TempDir(), "a", "b")
	v, err := product.Exec(fake.Ctx(), t, reg, "pull", product.Input(t, "pull", map[string]any{"id": "s1", "dir": dir}, nil))
	if err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"Code.gs": "function main() {}\n", "appsscript.json": `{"timeZone":"Europe/Paris"}`, "Index.html": "<p>héllo</p>",
		"Untyped.gs": "var x = 1;", ".clasp.json": "{\n  \"scriptId\": \"s1\",\n  \"rootDir\": \".\"\n}\n",
	} {
		if got, err := os.ReadFile(filepath.Join(dir, name)); err != nil || string(got) != want {
			t.Errorf("%s: %q %v", name, got, err)
		}
	}
	want := "Pulled 4 file(s) from s1 into " + dir + "\n  " + dir + "/Code.gs (SERVER_JS)\n  " + dir + "/appsscript.json (JSON)\n  " +
		dir + "/Index.html (HTML)\n  " + dir + "/Untyped.gs (SERVER_JS)\n"
	if got := product.Printed(t, "pull", v, false); got != want {
		t.Fatalf("%q", got)
	}
	// Pulling the same script again is fine; another one needs --force.
	if _, err := product.Exec(fake.Ctx(), t, reg, "pull", product.Input(t, "pull", map[string]any{"id": "s1", "dir": dir}, nil)); err != nil {
		t.Fatal(err)
	}
	before := len(fake.Recorded())
	_, err = product.Exec(fake.Ctx(), t, reg, "pull", product.Input(t, "pull", map[string]any{"id": "s2", "dir": dir}, nil))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.InvalidParams || ce.Message != filepath.Join(dir, ".clasp.json")+" already points to scriptId s1" ||
		ce.Suggestion != "Pass --force to overwrite, or pull into a different directory" || len(fake.Recorded()) != before {
		t.Fatalf("%#v", ce)
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "pull", product.Input(t, "pull", map[string]any{"id": "s2", "dir": dir}, map[string]any{"force": true})); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, ".clasp.json")); !strings.Contains(string(got), `"s2"`) {
		t.Fatalf("%s", got)
	}
	// A .clasp.json Bun cannot read fails with JavaScriptCore's message.
	for clasp, want := range map[string]string{
		"{bad": "JSON Parse error: Expected '}'",
		"null": "null is not an object (evaluating 'existing.scriptId')",
	} {
		bad := t.TempDir()
		_ = os.WriteFile(filepath.Join(bad, ".clasp.json"), []byte(clasp), 0o666)
		_, err := product.Exec(fake.Ctx(), t, reg, "pull", product.Input(t, "pull", map[string]any{"id": "s1", "dir": bad}, nil))
		if err == nil || err.Error() != want {
			t.Errorf("%s: %v", clasp, err)
		}
	}
	file := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(file, nil, 0o666)
	_, err = product.Exec(fake.Ctx(), t, reg, "pull", product.Input(t, "pull", map[string]any{"id": "s1", "dir": file}, nil))
	if err == nil || err.Error() != "EEXIST: file already exists, mkdir '"+file+"'" {
		t.Fatal(err)
	}
}

func TestPushReadsTheDirectoryLikeBun(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := scriptFake(t, nil)
	dir := scriptDir(t, "s1", map[string]string{
		"appsscript.json": "{}", "Code.gs": "code", "Page.html": "<p>", "Upper.GS": "up", "empty.gs": "",
		".hidden.gs": "no", "notes.txt": "no",
	})
	if err := os.Mkdir(filepath.Join(dir, "sub.gs"), 0o777); err != nil {
		t.Fatal(err)
	}
	v, err := product.Exec(fake.Ctx(), t, reg, "push", product.Input(t, "push", map[string]any{"dir": dir}, nil))
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Method != "PUT" || h.Path != "/v1/projects/s1/content" {
		t.Fatalf("%s %s", h.Method, h.Path)
	}
	sent := map[string]string{}
	for _, f := range h.JSON["files"].([]any) {
		m := f.(map[string]any)
		if _, ok := m["source"]; !ok {
			t.Fatalf("an empty source was dropped: %v", m)
		}
		sent[m["name"].(string)] = m["type"].(string) + ":" + m["source"].(string)
	}
	// basename(entry, ext) with the lowercased ext keeps "Upper.GS" whole.
	if googletest.JSONText(sent) != `{"Code":"SERVER_JS:code","Page":"HTML:\u003cp\u003e","Upper.GS":"SERVER_JS:up","appsscript":"JSON:{}","empty":"SERVER_JS:"}` {
		t.Fatal(googletest.JSONText(sent))
	}
	if got := product.Printed(t, "push", v, false); !strings.HasPrefix(got, "Pushed 5 file(s) to s1\n") || !strings.Contains(got, "\n  Upper.GS (SERVER_JS)") {
		t.Fatalf("%q", got)
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "push", product.Input(t, "push", map[string]any{"dir": dir}, map[string]any{"id": "other"})); err != nil {
		t.Fatal(err)
	}
	if all := fake.Recorded(); all[len(all)-1].Path != "/v1/projects/other/content" {
		t.Fatal(all[len(all)-1].Path)
	}

	before := len(fake.Recorded())
	noManifest := scriptDir(t, "s1", map[string]string{"Code.gs": "x"})
	noID := scriptDir(t, "", map[string]string{".clasp.json": `{"rootDir":"."}`, "appsscript.json": "{}"})
	missing := filepath.Join(t.TempDir(), "missing")
	for _, c := range []struct {
		dir, id, code, message string
	}{
		{noManifest, "", "INVALID_PARAMS", "Apps Script API requires an appsscript.json manifest in " + noManifest},
		{noID, "", "INVALID_PARAMS", ".clasp.json missing scriptId field"},
		{scriptDir(t, "", nil), "", "INVALID_PARAMS", "No .clasp.json found in "},
		{missing, "x", "", "ENOENT: no such file or directory, scandir '" + missing + "'"},
	} {
		_, err := product.Exec(fake.Ctx(), t, reg, "push", product.Input(t, "push", map[string]any{"dir": c.dir}, map[string]any{"id": c.id}))
		if ce, ok := err.(*clierr.Error); ok {
			if string(ce.Code) != c.code || !strings.HasPrefix(ce.Message, c.message) {
				t.Errorf("%s: %#v", c.dir, ce)
			}
		} else if err == nil || c.code != "" || err.Error() != c.message {
			t.Errorf("%s: %v", c.dir, err)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("a rejected push reached the API")
	}
}

func TestGetPrintsTheSourceVerbatim(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := scriptFake(t, map[string]string{"GET /v1/projects/empty/content": `{"scriptId":"empty"}`})
	for file, want := range map[string]string{
		"Code": "function main() {}\n", "Code.gs": "function main() {}\n", "dir/Code.gs": "function main() {}\n",
		"Untyped": "var x = 1;", "appsscript": `{"timeZone":"Europe/Paris"}`, "Index.html": "<p>héllo</p>",
	} {
		v, err := product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"id": "s1", "file": file}, nil))
		if err != nil {
			t.Fatal(err)
		}
		if got := product.Printed(t, "get", v, false); got != want {
			t.Errorf("%s: %q", file, got)
		}
	}
	_, err := product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"id": "s1", "file": "Nope.gs"}, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.NotFound || ce.Message != `No file named "Nope" in script s1` || ce.Suggestion != "Available: Code, appsscript, Index, Untyped" {
		t.Fatalf("%#v", ce)
	}
	_, err = product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"id": "empty", "file": "Code"}, nil))
	if ce := googletest.CliErr(t, err); ce.Suggestion != "Available: (empty)" {
		t.Fatalf("%#v", ce)
	}
}

func TestPutInfersTheTypeAndReadsItsSource(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := scriptFake(t, nil)
	from := filepath.Join(t.TempDir(), "src.gs")
	_ = os.WriteFile(from, []byte("from file\n"), 0o666)
	put := func(file string, set map[string]any, stdin any) (any, error) {
		in := product.Input(t, "put", map[string]any{"id": "s1", "file": file}, set)
		in.Stdin = stdin
		return product.Exec(fake.Ctx(), t, reg, "put", in)
	}
	lastFiles := func() map[string]string {
		all := fake.Recorded()
		out := map[string]string{}
		for _, f := range all[len(all)-1].JSON["files"].([]any) {
			m := f.(map[string]any)
			out[m["name"].(string)] = m["type"].(string) + ":" + m["source"].(string)
		}
		return out
	}
	cases := []struct {
		file  string
		set   map[string]any
		stdin any
		name  string
		want  string
	}{
		{"Code", map[string]any{"source": "new"}, nil, "Code", "SERVER_JS:new"},
		{"Index.gs", map[string]any{"source": "keeps HTML"}, nil, "Index", "HTML:keeps HTML"},
		{"Helpers", map[string]any{"source": "h"}, nil, "Helpers", "SERVER_JS:h"},
		{"New.HTML", map[string]any{"source": "<p>"}, nil, "New", "HTML:<p>"},
		{"Code", map[string]any{"from": from}, nil, "Code", "SERVER_JS:from file\n"},
		{"Code", nil, "  piped \n\n", "Code", "SERVER_JS:piped"},
	}
	for _, c := range cases {
		v, err := put(c.file, c.set, c.stdin)
		if err != nil {
			t.Fatalf("%s: %v", c.file, err)
		}
		files := lastFiles()
		if files[c.name] != c.want {
			t.Errorf("%s: %q", c.file, files[c.name])
		}
		if n := len(files); (c.name == "Helpers" || c.name == "New") != (n == 5) {
			t.Errorf("%s: %d files sent", c.file, n)
		}
		if got := product.Printed(t, "put", v, false); !strings.HasPrefix(got, "Pushed ") {
			t.Errorf("%q", got)
		}
	}
	before := len(fake.Recorded())
	missing := filepath.Join(t.TempDir(), "none.gs")
	for _, c := range []struct {
		file    string
		set     map[string]any
		code    clierr.Code
		message string
	}{
		{"Code", map[string]any{"source": "a", "from": "b"}, clierr.InvalidParams, "--source and --from are mutually exclusive"},
		{"Code", nil, clierr.InvalidParams, "No content provided"},
		{"Code", map[string]any{"from": missing}, "", "ENOENT: no such file or directory, open '" + missing + "'"},
	} {
		_, err := put(c.file, c.set, nil)
		if ce, ok := err.(*clierr.Error); ok {
			if ce.Code != c.code || ce.Message != c.message {
				t.Errorf("%#v", ce)
			}
		} else if err == nil || c.code != "" || err.Error() != c.message {
			t.Errorf("%v", err)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("a rejected put reached the API")
	}
	// The JSON rule is checked after the content is read, as in Bun.
	_, err := put("cfg.json", map[string]any{"source": "{}"}, nil)
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != `JSON files must be named "appsscript"` {
		t.Fatalf("%#v", ce)
	}
	if all := fake.Recorded(); len(all) != before+1 || all[before].Method != "GET" {
		t.Fatal("the JSON rule sent an update")
	}
}

func TestStripExtAndLocalNamesMatchNode(t *testing.T) {
	// Bun stripExt (Node extname + basename).
	for in, want := range map[string]string{
		"Code": "Code", "Code.gs": "Code", "a.b.gs": "a.b", "dir/Code.gs": "Code", "dir/Code": "dir/Code",
		".gs": ".gs", "a.": "a", "Code.GS": "Code",
	} {
		if got := stripExt(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
	if localFilename(file{Name: "x", Type: "ENUM_TYPE_UNSPECIFIED"}) != "xundefined" || localFilename(file{Name: "x", Type: "HTML"}) != "x.html" {
		t.Fatal("localFilename")
	}
}

// Every API failure is `Failed to <operation>: <message>` with the mapped code,
// and no partial value reaches the printer.
func TestAPIErrorsMatchBun(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	var status int
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": "Backend says no"}})
	})
	dir := scriptDir(t, "s1", map[string]string{"appsscript.json": "{}"})
	pullDir := filepath.Join(t.TempDir(), "pull")
	args := map[string]any{"id": "s1", "file": "Code", "dir": dir}
	cmds := []struct {
		path, operation string
		set             map[string]any
		args            map[string]any
	}{
		{"create", "create script project", map[string]any{"title": "T"}, nil},
		{"metadata", "get script project metadata", nil, nil},
		{"list", "list script projects", nil, nil},
		{"delete", "delete script project", map[string]any{"force": true}, nil},
		{"delete", "get script project metadata", nil, nil},
		{"pull", "get script content", nil, map[string]any{"id": "s1", "dir": pullDir}},
		{"push", "update script content", nil, nil},
		{"get", "get script content", nil, nil},
		{"put", "get script content", map[string]any{"source": "x"}, nil},
	}
	messages := map[int]struct {
		code    clierr.Code
		message string
	}{
		401: {clierr.AuthFailed, "OAuth token expired or invalid"},
		403: {clierr.PermissionDenied, "Insufficient permissions for this script project"},
		404: {clierr.NotFound, "Script project not found"},
		400: {"API_ERROR", "Backend says no"},
	}
	for s, want := range messages {
		status = s
		for _, c := range cmds {
			a := args
			if c.args != nil {
				a = c.args
			}
			v, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, a, c.set))
			ce := googletest.CliErr(t, err)
			if v != nil || ce.Code != want.code || ce.Message != "Failed to "+c.operation+": "+want.message || ce.Suggestion != "" {
				t.Fatalf("%d %s: %v %#v", s, c.path, v, ce)
			}
		}
	}
	if _, err := os.Stat(filepath.Join(pullDir, ".clasp.json")); err == nil {
		t.Fatal("a failed pull wrote .clasp.json")
	}
}
