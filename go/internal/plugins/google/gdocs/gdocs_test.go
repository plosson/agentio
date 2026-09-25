package gdocs

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
	"github.com/plosson/agentio/go/internal/plugins/google"
	"github.com/plosson/agentio/go/internal/plugins/google/googletest"
	"github.com/plosson/agentio/go/internal/vault"
)

// product drives New() through the shared Google test harness.
var product = googletest.For(New)

// storedCreds is a Bun GDocsCredentials object (camelCase keys).
func storedCreds(expiry int64) map[string]any {
	return map[string]any{
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"tokenType":    "Bearer",
		"scope":        "https://www.googleapis.com/auth/documents",
		"email":        "me@example.com",
	}
}

func fresh() map[string]any { return storedCreds(time.Now().Add(time.Hour).UnixMilli()) }

// The command table is the Bun surface: `bun run src/index.ts gdocs --help`
// and each leaf's --help.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op, input string
		format                         bool
	}
	want := map[string]row{
		"get":       {"<doc-id-or-url>", "--format <format>=markdown --output <file>", "read", "", "", false},
		"create":    {"", "--title <title>! --content <text> --folder <folder-id>", "write", "create document", "text", true},
		"list":      {"", "--limit <n>=10 --query <query>", "read", "", "", true},
		"structure": {"<doc-id-or-url>", "--tab <tab-id> --all-tabs", "read", "", "", false},
		"tabs":      {"<doc-id-or-url>", "", "read", "", "", true},
		"batch":     {"<doc-id-or-url>", "--requests-json <json> --file <path>", "write", "execute batch update", "", false},
	}
	p := New()
	if p.ID != "gdocs" || p.DisplayName != "Google Docs" || p.Description != "Use when interacting with Google Docs via the agentio CLI - list, read, create." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, " ") != "get create list structure tabs batch" {
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
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input, c.Format != nil}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || len(c.Aliases) != 0 {
			t.Errorf("%s: examples %d aliases %v", c.Path, len(c.Examples), c.Aliases)
		}
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken" {
		t.Fatal("gdocs is a camelCase Google lifecycle")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/documents"})
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
	wantScope := "https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email"
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
	// camelCase, as GDocsCredentials: a snake_case key would not open a Bun vault.
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
	if out.String() != "Profile \"user@example.com\" configured!\nEmail: user@example.com\nTest with: agentio gdocs list\n" {
		t.Fatalf("%q", out.String())
	}
	if len(logs) == 0 || logs[0] != "Starting OAuth flow for Google Docs...\n" {
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
	if c, _ := vault.Load(); len(c.Credentials["gdocs"]) != 0 {
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
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gdocs", "acme", auth.RefreshOptions{})
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
		stored["legacy"] != "kept" || stored["scope"] != "https://www.googleapis.com/auth/documents" {
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
	_, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, nil))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gdocs profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gdocs profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", fresh(), true)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch {
		case strings.HasSuffix(h.Path, "/export"):
			_, _ = io.WriteString(w, "# Doc")
		case strings.HasPrefix(h.Path, "/v1/documents/"):
			googletest.WriteRaw(w, 200, `{"documentId":"d1","tabs":[]}`)
		default:
			googletest.WriteJSON(w, 200, map[string]any{"files": []any{}})
		}
	})
	for path, op := range map[string]string{"create": "create document", "batch": "execute batch update"} {
		in := product.Input(t, path, map[string]any{"doc-id-or-url": "d1"}, map[string]any{"title": "T", "content": "# x", "requests-json": `[{"insertText":{}}]`})
		ce := googletest.CliErr(t, func() error { _, err := product.Exec(fake.Ctx(), t, reg, path, in); return err }())
		if ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio gdocs profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	// Bun checks create's --title, then its content (--content, else trimmed
	// stdin), before enforceWriteAccess; piped content satisfies it.
	for _, c := range []struct {
		set   map[string]any
		stdin any
		code  clierr.Code
		msg   string
	}{
		{map[string]any{"content": "# x"}, nil, clierr.InvalidParams, "required option '--title <title>' not specified"},
		{map[string]any{"title": "T"}, nil, clierr.InvalidParams, "No content provided"},
		{map[string]any{"title": "T", "content": ""}, " \n\t\ufeff", clierr.InvalidParams, "No content provided"},
		{map[string]any{"title": "T"}, "# piped", clierr.PermissionDenied, `Cannot create document: profile "ro" is read-only`},
	} {
		in := product.Input(t, "create", nil, c.set)
		in.Stdin = c.stdin
		_, err := product.Exec(fake.Ctx(), t, reg, "create", in)
		if ce := googletest.CliErr(t, err); ce.Code != c.code || ce.Message != c.msg {
			t.Fatalf("%v %q: %#v", c.set, c.stdin, ce)
		}
	}
	// Bun checks the batch input before enforceWriteAccess.
	_, err := product.Exec(fake.Ctx(), t, reg, "batch", product.Input(t, "batch", map[string]any{"doc-id-or-url": "d1"}, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "Provide --requests-json or --file" {
		t.Fatalf("%#v", ce)
	}
	for _, path := range []string{"get", "list", "structure", "tabs"} {
		if _, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, map[string]any{"doc-id-or-url": "d1"}, nil)); err != nil {
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
			h.Query.Get("q") != "mimeType='application/vnd.google-apps.document'" {
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
	out := auth.RedactForRemote(reg, "gdocs", creds)
	if _, ok := out["refreshToken"]; ok || out["accessToken"] != "at-old" || out["email"] != "me@example.com" || out["expiryDate"] != int64(5) {
		t.Fatalf("%#v", out)
	}
	if creds["refreshToken"] != "rt-old" {
		t.Fatal("redaction changed the caller's map")
	}
}

func TestListInfoAndReauthenticate(t *testing.T) {
	if google.EmailListInfo(map[string]any{"email": "me@example.com"}) != " - me@example.com" || google.EmailListInfo(map[string]any{}) != "" {
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
		if !strings.Contains(o.AuthorizationURL("http://localhost:3000/callback"), "auth%2Fdocuments") {
			t.Error("reauthenticate did not ask for the gdocs scopes")
		}
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:3000/callback"}, nil
	}
	got, err := New().Profile.Reauthenticate(fake.Ctx(), storedCreds(1), "work", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["accessToken"] != "at-2" || got["refreshToken"] != "rt-2" || got["email"] != "me@example.com" {
		t.Fatalf("%#v", got)
	}
	if _, ok := got["access_token"]; ok {
		t.Fatalf("snake_case key %#v", got)
	}
	if strings.Join(logs, "|") != "\nRe-authenticating gdocs / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

func TestListSendsTheBunQueryAndFillsFallbacks(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"files": []any{
			map[string]any{"id": "d1", "name": "Plan", "owners": []any{map[string]any{"displayName": "Ann", "emailAddress": "ann@example.com"}},
				"createdTime": "2024-01-01T00:00:00.000Z", "modifiedTime": "2024-02-01T00:00:00.000Z", "webViewLink": "https://docs.google.com/document/d/d1/edit"},
			map[string]any{"id": "d2", "owners": []any{map[string]any{"emailAddress": "bob@example.com"}}},
			map[string]any{"id": "d3", "name": "", "owners": []any{}},
		}})
	})
	cases := []struct {
		set      map[string]any
		pageSize string
		q        string
	}{
		{nil, "10", "mimeType='application/vnd.google-apps.document' and trashed=false"},
		{map[string]any{"limit": "500", "query": "'me' in owners"}, "100", "mimeType='application/vnd.google-apps.document' and trashed=false and 'me' in owners"},
		{map[string]any{"limit": "abc"}, "NaN", "mimeType='application/vnd.google-apps.document' and trashed=false"},
		{map[string]any{"limit": "7.9"}, "7", "mimeType='application/vnd.google-apps.document' and trashed=false"},
	}
	var docs any
	for _, c := range cases {
		v, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, c.set))
		if err != nil {
			t.Fatal(err)
		}
		docs = v
		all := fake.Recorded()
		h := all[len(all)-1]
		if h.Method != "GET" || h.Path != "/files" || h.Query.Get("pageSize") != c.pageSize || h.Query.Get("q") != c.q ||
			h.Query.Get("fields") != "files(id,name,owners,createdTime,modifiedTime,webViewLink)" || h.Query.Get("orderBy") != "modifiedTime desc" {
			t.Fatalf("%v", h.Query)
		}
	}
	want := `[{"id":"d1","title":"Plan","owner":"Ann","createdTime":"2024-01-01T00:00:00.000Z","modifiedTime":"2024-02-01T00:00:00.000Z","webViewLink":"https://docs.google.com/document/d/d1/edit"},` +
		`{"id":"d2","title":"Untitled","owner":"bob@example.com","webViewLink":"https://docs.google.com/document/d/d2"},` +
		`{"id":"d3","title":"Untitled","webViewLink":"https://docs.google.com/document/d/d3"}]`
	if raw, _ := json.Marshal(docs); string(raw) != want {
		t.Fatalf("%s", raw)
	}
	wantText := "Documents (3)\n\n[1] Plan\n    ID: d1\n    Owner: Ann\n    Modified: 2024-02-01T00:00:00.000Z\n    Link: https://docs.google.com/document/d/d1/edit\n\n" +
		"[2] Untitled\n    ID: d2\n    Owner: bob@example.com\n    Link: https://docs.google.com/document/d/d2\n\n" +
		"[3] Untitled\n    ID: d3\n    Link: https://docs.google.com/document/d/d3\n\n"
	if got := product.Printed(t, "list", docs, false); got != wantText {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "list", []google.DriveFile{}, false); got != "No documents found\n" {
		t.Fatalf("%q", got)
	}
}

func TestGetExportsMarkdownAndDocx(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		w.Header().Set("Content-Type", h.Query.Get("mimeType"))
		switch h.Query.Get("mimeType") {
		case "text/markdown":
			_, _ = io.WriteString(w, "# Title\n\nBody é\n")
		default:
			_, _ = w.Write([]byte{0x50, 0x4b, 0x03, 0x04, 0x00, 0xff})
		}
	})
	url := "https://docs.google.com/document/d/1A2b_C-d/edit?tab=t.0"
	v, err := product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"doc-id-or-url": url}, nil))
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Path != "/files/1A2b_C-d/export" || h.Query.Get("mimeType") != "text/markdown" {
		t.Fatalf("%s %v", h.Path, h.Query)
	}
	// console.log(markdown): the export as is, then a newline.
	if got := product.Printed(t, "get", v, false); got != "# Title\n\nBody é\n\n" {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "get", "", false); got != "\n" {
		t.Fatalf("empty export %q", got)
	}

	dir := t.TempDir()
	md := filepath.Join(dir, "report.md")
	v, err = product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"output": md}))
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(md); string(got) != "# Title\n\nBody é\n" || product.Printed(t, "get", v, false) != "Exported to "+md+"\n" {
		t.Fatalf("%q %v", got, v)
	}

	docx := filepath.Join(dir, "report.docx")
	v, err = product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"format": "DOCX", "output": docx}))
	if err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if q := all[len(all)-1].Query.Get("mimeType"); q != docxMimeType {
		t.Fatalf("%q", q)
	}
	if got, _ := os.ReadFile(docx); !bytes.Equal(got, []byte{0x50, 0x4b, 0x03, 0x04, 0x00, 0xff}) || v != "Exported to "+docx {
		t.Fatalf("%v %v", got, v)
	}

	before := len(fake.Recorded())
	for _, c := range []struct {
		set                 map[string]any
		message, suggestion string
	}{
		{map[string]any{"format": "PDF"}, "Unknown format: pdf", "Use --format markdown or --format docx"},
		{map[string]any{"format": "docx"}, "Output file required for docx format", "Use --output <file.docx>"},
	} {
		v, err := product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"doc-id-or-url": "d1"}, c.set))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%#v", ce)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("an invalid get reached the API")
	}
}

func TestCreateUploadsMarkdownWithTheBunMetadata(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	var respond map[string]any
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, respond)
	})
	parts := func(h googletest.Hit) (map[string]any, string, string) {
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

	respond = map[string]any{"id": "new1", "name": "Meeting Notes", "webViewLink": "https://docs.google.com/document/d/new1/edit"}
	in := product.Input(t, "create", nil, map[string]any{"title": "Meeting Notes", "content": "  # Agenda\n", "folder": "fold1"})
	in.Stdin = "ignored"
	v, err := product.Exec(fake.Ctx(), t, reg, "create", in)
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Method != "POST" || h.Path != "/upload/drive/v3/files" || h.Query.Get("uploadType") != "multipart" || h.Query.Get("fields") != "id,name,webViewLink" {
		t.Fatalf("%s %s %v", h.Method, h.Path, h.Query)
	}
	meta, mediaType, body := parts(h)
	if googletest.JSONText(meta) != `{"mimeType":"application/vnd.google-apps.document","name":"Meeting Notes","parents":["fold1"]}` ||
		!strings.HasPrefix(mediaType, "text/markdown") || body != "  # Agenda\n" {
		t.Fatalf("%v %q %q", meta, mediaType, body)
	}
	if got := product.Printed(t, "create", v, false); got != "Document created\nID: new1\nTitle: Meeting Notes\nLink: https://docs.google.com/document/d/new1/edit\n" {
		t.Fatalf("%q", got)
	}

	// Piped markdown is trimmed; no folder sends no parents; missing fields fall back.
	respond = map[string]any{"id": "new2"}
	in = product.Input(t, "create", nil, map[string]any{"title": "Q4"})
	in.Stdin = "\n# Q4 plan\n\n"
	v, err = product.Exec(fake.Ctx(), t, reg, "create", in)
	if err != nil {
		t.Fatal(err)
	}
	meta, _, body = parts(fake.Recorded()[1])
	if googletest.JSONText(meta) != `{"mimeType":"application/vnd.google-apps.document","name":"Q4"}` || body != "# Q4 plan" {
		t.Fatalf("%v %q", meta, body)
	}
	if googletest.JSONText(v) != `{"id":"new2","title":"Q4","webViewLink":"https://docs.google.com/document/d/new2"}` {
		t.Fatalf("%s", googletest.JSONText(v))
	}

	for _, c := range []struct {
		set                 map[string]any
		stdin               any
		message, suggestion string
	}{
		{map[string]any{"content": "x"}, nil, "required option '--title <title>' not specified", ""},
		{map[string]any{"title": "T"}, nil, "No content provided", "Provide --content or pipe markdown via stdin"},
		{map[string]any{"title": "T"}, " \n\t", "No content provided", "Provide --content or pipe markdown via stdin"},
	} {
		in := product.Input(t, "create", nil, c.set)
		in.Stdin = c.stdin
		v, err := product.Exec(fake.Ctx(), t, reg, "create", in)
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%#v", ce)
		}
	}
	if n := len(fake.Recorded()); n != 2 {
		t.Fatalf("an invalid create reached the API: %d", n)
	}
}

// The Docs API escapes <, >, = and & and orders keys its own way; Bun prints
// JSON.parse then JSON.stringify of that, false and zero values included.
const docJSON = `{"title":"Plan \u003cv2\u003e","documentId":"d1","body":{"content":[{"endIndex":1,"sectionBreak":{"sectionStyle":{"columnSeparatorStyle":"NONE"}}},` +
	`{"startIndex":1,"paragraph":{"elements":[{"textRun":{"content":"a=b \u0026 c\n","textStyle":{"bold":false}}}]}}]},` +
	`"tabs":[{"tabProperties":{"tabId":"t.0","title":"One","index":0},"documentTab":{"body":{"content":[]}},` +
	`"childTabs":[{"tabProperties":{"tabId":"t.kid","title":"Kid","parentTabId":"t.0"},"documentTab":{"body":{"content":[{"endIndex":5}]},"futureField":true}}]},` +
	`{"tabProperties":{"tabId":"t.2","title":"Two"}}],"revisionId":"r1"}`

func TestStructurePrintsTheDocumentAsTheAPISentIt(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteRaw(w, 200, docJSON)
	})
	v, err := product.Exec(fake.Ctx(), t, reg, "structure", product.Input(t, "structure", map[string]any{"doc-id-or-url": "https://docs.google.com/document/d/d1/edit"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Method != "GET" || h.Path != "/v1/documents/d1" || h.Query.Get("includeTabsContent") != "false" || h.Auth != "Bearer at-old" {
		t.Fatalf("%s %s %v", h.Method, h.Path, h.Query)
	}
	got := product.Printed(t, "structure", v, false)
	if !strings.HasPrefix(got, "{\n  \"title\": \"Plan <v2>\",\n  \"documentId\": \"d1\",\n  \"body\": {\n    \"content\": [\n      {\n        \"endIndex\": 1,") ||
		!strings.Contains(got, `"content": "a=b & c\n",`) || !strings.Contains(got, `"bold": false`) || !strings.HasSuffix(got, "  \"revisionId\": \"r1\"\n}\n") {
		t.Fatalf("%s", got)
	}
	// --json prints the same value the same way.
	if product.Printed(t, "structure", v, true) != got {
		t.Fatal("--json differs")
	}

	// --tab finds a nested tab and prints its documentTab only.
	v, err = product.Exec(fake.Ctx(), t, reg, "structure", product.Input(t, "structure", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"tab": "t.kid"}))
	if err != nil {
		t.Fatal(err)
	}
	if q := fake.Recorded()[1].Query.Get("includeTabsContent"); q != "true" {
		t.Fatalf("includeTabsContent %q", q)
	}
	if got := product.Printed(t, "structure", v, false); got != "{\n  \"body\": {\n    \"content\": [\n      {\n        \"endIndex\": 5\n      }\n    ]\n  },\n  \"futureField\": true\n}\n" {
		t.Fatalf("%q", got)
	}
	// A tab without documentTab prints JSON.stringify(undefined).
	v, err = product.Exec(fake.Ctx(), t, reg, "structure", product.Input(t, "structure", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"tab": "t.2"}))
	if err != nil || product.Printed(t, "structure", v, false) != "undefined\n" {
		t.Fatalf("%v %v", v, err)
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "structure", product.Input(t, "structure", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"all-tabs": true})); err != nil {
		t.Fatal(err)
	}
	if q := fake.Recorded()[3].Query.Get("includeTabsContent"); q != "true" {
		t.Fatalf("--all-tabs includeTabsContent %q", q)
	}

	v, err = product.Exec(fake.Ctx(), t, reg, "structure", product.Input(t, "structure", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"tab": "t.nope"}))
	ce := googletest.CliErr(t, err)
	if v != nil || ce.Code != clierr.NotFound || ce.Message != "Tab not found: t.nope" || ce.Suggestion != "Available tabs: t.0 (One), t.kid (Kid), t.2 (Two)" {
		t.Fatalf("%#v", ce)
	}

	before := len(fake.Recorded())
	_, err = product.Exec(fake.Ctx(), t, reg, "structure", product.Input(t, "structure", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"tab": "t.0", "all-tabs": true}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "--tab and --all-tabs are mutually exclusive" || len(fake.Recorded()) != before {
		t.Fatalf("%#v", ce)
	}
}

func TestStructureWithoutTabsSuggestsTheTabsCommand(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) { googletest.WriteRaw(w, 200, `{"documentId":"d1"}`) })
	_, err := product.Exec(fake.Ctx(), t, reg, "structure", product.Input(t, "structure", map[string]any{"doc-id-or-url": "d1"}, map[string]any{"tab": "t.1"}))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.NotFound || ce.Suggestion != "Run: agentio gdocs tabs <doc-id-or-url>" {
		t.Fatalf("%#v", ce)
	}
	v, err := product.Exec(fake.Ctx(), t, reg, "tabs", product.Input(t, "tabs", map[string]any{"doc-id-or-url": "d1"}, nil))
	if err != nil || product.Printed(t, "tabs", v, false) != "No tabs found (document has a single untitled tab)\n" || product.Printed(t, "tabs", v, true) != "[]\n" {
		t.Fatalf("%v %v", v, err)
	}
}

func TestTabsFlattensTheTreeWithDepth(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) { googletest.WriteRaw(w, 200, docJSON) })
	v, err := product.Exec(fake.Ctx(), t, reg, "tabs", product.Input(t, "tabs", map[string]any{"doc-id-or-url": "d1"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if q := fake.Recorded()[0].Query.Get("includeTabsContent"); q != "true" {
		t.Fatalf("includeTabsContent %q", q)
	}
	if got := product.Printed(t, "tabs", v, false); got != "Tabs (3)\n\nt.0\tOne\n  t.kid\tKid\nt.2\tTwo\n" {
		t.Fatalf("%q", got)
	}
	if googletest.JSONText(v) != `[{"id":"t.0","title":"One","depth":0},{"id":"t.kid","title":"Kid","depth":1},{"id":"t.2","title":"Two","depth":0}]` {
		t.Fatalf("%s", googletest.JSONText(v))
	}
}

func TestBatchForwardsTheRequestsVerbatim(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteRaw(w, 200, `{"replies":[{},{"createHeader":{"headerId":"kix.h1"}}],"writeControl":{"requiredRevisionId":"r2"},"documentId":"d1"}`)
	})
	// bold:false and an unknown request field would be dropped by the typed docs/v1 structs.
	requests := `[{"updateTextStyle":{"range":{"startIndex":1,"endIndex":10,"tabId":"t.0"},"textStyle":{"bold":false},"fields":"bold"}},{"createHeader":{"type":"DEFAULT","futureOption":1.50}}]`
	var logs []string
	run := func(set map[string]any) (any, error) {
		in := product.Input(t, "batch", map[string]any{"doc-id-or-url": "https://docs.google.com/document/d/d1/edit"}, set)
		p := reg.Find("gdocs")
		sp := product.Spec(t, "batch")
		wrapped := *sp
		wrapped.Run = func(ctx context.Context, in plugins.CommandInput, rc *plugins.RunContext) (any, error) {
			rc.Log = func(parts ...any) { logs = append(logs, parts[0].(string)) }
			return sp.Run(ctx, in, rc)
		}
		return host.Execute(fake.Ctx(), reg, p, &wrapped, in)
	}
	v, err := run(map[string]any{"requests-json": requests})
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	wantBody := `{"requests":[{"updateTextStyle":{"range":{"startIndex":1,"endIndex":10,"tabId":"t.0"},"textStyle":{"bold":false},"fields":"bold"}},{"createHeader":{"type":"DEFAULT","futureOption":1.5}}]}`
	if h.Method != "POST" || h.Path != "/v1/documents/d1:batchUpdate" || h.Raw != wantBody {
		t.Fatalf("%s %s %s", h.Method, h.Path, h.Raw)
	}
	if strings.Join(logs, "|") != "Batch update applied to d1 (2 replies)" {
		t.Fatalf("%q", logs)
	}
	want := "{\n  \"documentId\": \"d1\",\n  \"replies\": [\n    {},\n    {\n      \"createHeader\": {\n        \"headerId\": \"kix.h1\"\n      }\n    }\n  ]\n}\n"
	if got := product.Printed(t, "batch", v, false); got != want {
		t.Fatalf("%q", got)
	}

	// --file reads the same array; no replies in the response prints [].
	file := filepath.Join(t.TempDir(), "requests.json")
	if err := os.WriteFile(file, []byte(requests), 0o600); err != nil {
		t.Fatal(err)
	}
	fake.SetHandle(func(w http.ResponseWriter, h googletest.Hit) { googletest.WriteRaw(w, 200, `{"documentId":"d1"}`) })
	v, err = run(map[string]any{"file": file})
	if err != nil {
		t.Fatal(err)
	}
	if fake.Recorded()[1].Raw != wantBody || product.Printed(t, "batch", v, false) != "{\n  \"documentId\": \"d1\",\n  \"replies\": []\n}\n" {
		t.Fatalf("%s %v", fake.Recorded()[1].Raw, v)
	}

	before := len(fake.Recorded())
	for _, c := range []struct {
		set     map[string]any
		message string
	}{
		{map[string]any{}, "Provide --requests-json or --file"},
		{map[string]any{"requests-json": "[]", "file": file}, "--requests-json and --file are mutually exclusive"},
		{map[string]any{"requests-json": "[{"}, "Invalid JSON: "},
		{map[string]any{"requests-json": `{"insertText":{}}`}, "Input must be a JSON array of Request objects"},
		{map[string]any{"requests-json": "[]"}, "requests must be a non-empty array"},
	} {
		v, err := run(c.set)
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || !strings.HasPrefix(ce.Message, c.message) {
			t.Fatalf("%v: %#v", c.set, ce)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("an invalid batch reached the API")
	}
}

// Every API failure is `Failed to <operation>: <message>` with the mapped code,
// and no partial value reaches the printer. (429 is retried with real delays;
// its text is covered by google.StatusMessage.)
func TestAPIErrorsMatchBun(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	var status int
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, status, map[string]any{"error": map[string]any{"code": status, "message": "Backend says no"}})
	})
	cmds := []struct {
		path, operation string
		set             map[string]any
	}{
		{"get", "export document as markdown", nil},
		{"get", "export document as docx", map[string]any{"format": "docx", "output": filepath.Join(t.TempDir(), "x.docx")}},
		{"create", "create document", map[string]any{"title": "T", "content": "c"}},
		{"list", "list documents", nil},
		{"structure", "get document structure", nil},
		{"tabs", "list document tabs", nil},
		{"batch", "execute batch update", map[string]any{"requests-json": `[{"insertText":{}}]`}},
	}
	messages := map[int]struct {
		code    clierr.Code
		message string
	}{
		401: {clierr.AuthFailed, "OAuth token expired or invalid"},
		403: {clierr.PermissionDenied, "Insufficient permissions to access this document"},
		404: {clierr.NotFound, "Document not found"},
		400: {"API_ERROR", "Backend says no"},
	}
	for s, want := range messages {
		status = s
		for _, c := range cmds {
			v, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, map[string]any{"doc-id-or-url": "d1"}, c.set))
			ce := googletest.CliErr(t, err)
			if v != nil || ce.Code != want.code || ce.Message != "Failed to "+c.operation+": "+want.message || ce.Suggestion != "" {
				t.Fatalf("%d %s: %v %#v", s, c.path, v, ce)
			}
		}
	}
}

// Commander treats --title "" as present: Bun sends name "" to Drive, and on a
// read-only profile the read-only refusal is the answer.
func TestEmptyTitleIsSentAsGiven(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	product.SaveProfile(t, "ro", fresh(), true)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"id": "new1"})
	})
	in := product.Input(t, "create", nil, map[string]any{"title": "", "content": "# x", "profile": "acme"})
	if _, err := product.Exec(fake.Ctx(), t, reg, "create", in); err != nil {
		t.Fatal(err)
	}
	if raw := fake.Last().Raw; !strings.Contains(raw, `"name":""`) {
		t.Fatalf("metadata without an empty name: %q", raw)
	}
	in = product.Input(t, "create", nil, map[string]any{"title": "", "content": "# x", "profile": "ro"})
	_, err := product.Exec(fake.Ctx(), t, reg, "create", in)
	if ce := googletest.CliErr(t, err); ce.Code != clierr.PermissionDenied {
		t.Fatalf("%#v", ce)
	}
}
