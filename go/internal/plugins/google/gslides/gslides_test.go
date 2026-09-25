package gslides

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
	"github.com/plosson/agentio/go/internal/plugins/google"
	"github.com/plosson/agentio/go/internal/plugins/google/googletest"
	"github.com/plosson/agentio/go/internal/vault"
)

// product drives New() through the shared Google test harness.
var product = googletest.For(New)

// storedCreds is a Bun GSlidesCredentials object (camelCase keys).
func storedCreds(expiry int64) map[string]any {
	return map[string]any{
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"tokenType":    "Bearer",
		"scope":        "https://www.googleapis.com/auth/presentations",
		"email":        "me@example.com",
	}
}

func fresh() map[string]any { return storedCreds(time.Now().Add(time.Hour).UnixMilli()) }

// The command table is the Bun surface: `bun run src/index.ts gslides --help`
// and each leaf's --help.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op string
		format, accessFor       bool
	}
	want := map[string]row{
		"list":     {"", "--limit <n>=10 --query <query>", "read", "", true, false},
		"metadata": {"<id-or-url>", "", "read", "", true, false},
		"get":      {"<id-or-url>", "--slide <n>", "read", "", true, false},
		"export":   {"<id-or-url>", "--output <path> --format <fmt>=pptx", "read", "", false, false},
		"create":   {"<title>", "", "write", "create presentation", true, false},
		"copy":     {"<id-or-url> <title>", "--parent <folder-id>", "write", "copy presentation", true, false},
		"batch":    {"<id-or-url>", "--requests-json <json> --file <path>", "write", "execute batch update", true, true},
	}
	p := New()
	if p.ID != "gslides" || p.DisplayName != "Google Slides" || p.Description != "Use when interacting with Google Slides via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, " ") != "list metadata get export create copy batch" {
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
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Format != nil, c.AccessFor != nil}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || len(c.Aliases) != 0 || c.Input != "" {
			t.Errorf("%s: examples %d aliases %v input %q", c.Path, len(c.Examples), c.Aliases, c.Input)
		}
	}
	if p.Profile.Refresh == nil || strings.Join(p.Profile.Refresh.SecretFields, ",") != "refreshToken" {
		t.Fatal("gslides is a camelCase Google lifecycle")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/presentations"})
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
	wantScope := "https://www.googleapis.com/auth/presentations https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email"
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
	// camelCase, as GSlidesCredentials: a snake_case key would not open a Bun vault.
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
	if out.String() != "Profile \"user@example.com\" configured!\nEmail: user@example.com\nTest with: agentio gslides list\n" {
		t.Fatalf("%q", out.String())
	}
	if len(logs) == 0 || logs[0] != "Starting OAuth flow for Google Slides...\n" {
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
	if c, _ := vault.Load(); len(c.Credentials["gslides"]) != 0 {
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
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gslides", "acme", auth.RefreshOptions{})
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
		stored["legacy"] != "kept" || stored["scope"] != "https://www.googleapis.com/auth/presentations" {
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
	_, err := product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"id-or-url": "p1"}, nil))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gslides profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gslides profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

// deck is a presentations.get reply: a centered title with speaker notes, a
// slide with no text, and a slide whose text spans several runs.
const deck = `{"presentationId":"p1","title":"Quarterly Review",` +
	`"pageSize":{"width":{"magnitude":9144000,"unit":"EMU"},"height":{"magnitude":5143500,"unit":"EMU"}},"slides":[` +
	`{"objectId":"s1","pageElements":[` +
	`{"objectId":"t","shape":{"placeholder":{"type":"CENTERED_TITLE"},"text":{"textElements":[{"paragraphMarker":{}},{"textRun":{"content":"  Hello — world\n"}}]}}},` +
	`{"objectId":"u","shape":{"placeholder":{"type":"SUBTITLE"},"text":{"textElements":[{"textRun":{"content":"Line 1\nLine 2\n"}}]}}}],` +
	`"slideProperties":{"notesPage":{"pageElements":[{"objectId":"n0","shape":{"placeholder":{"type":"SLIDE_IMAGE"},"text":{"textElements":[{"textRun":{"content":"x"}}]}}},` +
	`{"objectId":"n1","shape":{"placeholder":{"type":"BODY"},"text":{"textElements":[{"textRun":{"content":"Speaker notes\n"}}]}}}]}}},` +
	`{"objectId":"s2","pageElements":[{"objectId":"img","image":{}},{"objectId":"blank","shape":{"text":{"textElements":[{"textRun":{"content":"\n"}}]}}}]},` +
	`{"objectId":"s3","pageElements":[{"objectId":"h","shape":{"placeholder":{"type":"TITLE"},"text":{"textElements":[{"textRun":{"content":"Agenda"}}]}}},` +
	`{"objectId":"m","shape":{"text":{"textElements":[{"textRun":{"content":"part A "}},{"autoText":{}},{"textRun":{"content":"part B\n\n"}}]}}}],` +
	`"slideProperties":{"notesPage":{"pageElements":[{"objectId":"n2","shape":{"placeholder":{"type":"BODY"},"text":{"textElements":[{"textRun":{"content":"\n"}}]}}}]}}}]}`

// slidesFake answers the Slides and Drive calls the commands make with
// canned bodies; reply overrides a "METHOD path".
func slidesFake(t *testing.T, reply map[string]string) *googletest.Fake {
	return googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if body, ok := reply[h.Method+" "+h.Path]; ok {
			googletest.WriteRaw(w, 200, body)
			return
		}
		switch {
		case h.Path == "/v1/presentations/p1" && h.Method == "GET":
			googletest.WriteRaw(w, 200, deck)
		case strings.HasSuffix(h.Path, "/export"):
			_, _ = io.WriteString(w, "PPTX")
		case h.Path == "/files":
			googletest.WriteJSON(w, 200, map[string]any{"files": []any{}})
		default:
			googletest.WriteRaw(w, 200, `{}`)
		}
	})
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", fresh(), true)
	fake := slidesFake(t, nil)
	args := map[string]any{"id-or-url": "p1", "title": "T"}
	for path, op := range map[string]string{"create": "create presentation", "copy": "copy presentation", "batch": "execute batch update"} {
		for _, requests := range []string{`[{"x":{}}]`, "[]"} {
			v, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, args, map[string]any{"requests-json": requests}))
			ce := googletest.CliErr(t, err)
			if v != nil || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
				ce.Suggestion != "To modify this profile's access: agentio gslides profile update --profile ro --no-read-only" {
				t.Fatalf("%s: %#v", path, ce)
			}
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	// Bun checks the batch input before enforceWriteAccess.
	_, err := product.Exec(fake.Ctx(), t, reg, "batch", product.Input(t, "batch", args, nil))
	if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != "Provide --requests-json or --file" {
		t.Fatalf("%#v", ce)
	}
	out := filepath.Join(t.TempDir(), "x.pptx")
	for _, path := range []string{"list", "metadata", "get", "export"} {
		if _, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, args, map[string]any{"output": out})); err != nil {
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
			h.Query.Get("q") != "mimeType='application/vnd.google-apps.presentation'" {
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
	out := auth.RedactForRemote(reg, "gslides", creds)
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
		if !strings.Contains(o.AuthorizationURL("http://localhost:3000/callback"), "auth%2Fpresentations") {
			t.Error("reauthenticate did not ask for the gslides scopes")
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
	if strings.Join(logs, "|") != "\nRe-authenticating gslides / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

func TestListSendsTheBunQueryAndFormats(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"files": []any{
			map[string]any{"id": "p1", "name": "Deck", "owners": []any{map[string]any{"displayName": "Ann"}}, "modifiedTime": "2024-02-01T00:00:00.000Z"},
			map[string]any{"id": "p2", "owners": []any{map[string]any{"emailAddress": "bob@example.com"}}, "webViewLink": "https://docs.google.com/presentation/d/p2/edit"},
		}})
	})
	v, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"limit": "250", "query": "name contains 'Q4'"}))
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Path != "/files" || h.Query.Get("pageSize") != "100" || h.Query.Get("q") != "mimeType='application/vnd.google-apps.presentation' and trashed=false and name contains 'Q4'" ||
		h.Query.Get("fields") != "files(id,name,owners,createdTime,modifiedTime,webViewLink)" || h.Query.Get("orderBy") != "modifiedTime desc" {
		t.Fatalf("%s %v", h.Path, h.Query)
	}
	want := "Presentations (2)\n\n[1] Deck\n    ID: p1\n    Owner: Ann\n    Modified: 2024-02-01T00:00:00.000Z\n    Link: https://docs.google.com/presentation/d/p1\n\n" +
		"[2] Untitled\n    ID: p2\n    Owner: bob@example.com\n    Link: https://docs.google.com/presentation/d/p2/edit\n\n"
	if got := product.Printed(t, "list", v, false); got != want {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "list", []google.DriveFile{}, false); got != "No presentations found\n" {
		t.Fatalf("%q", got)
	}
	// parseInt("abc") is NaN, which gaxios sends as is.
	if _, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"limit": "abc"})); err != nil {
		t.Fatal(err)
	}
	if all := fake.Recorded(); all[len(all)-1].Query.Get("pageSize") != "NaN" {
		t.Fatal(all[len(all)-1].Query)
	}
}

func TestMetadataReadsTitlesAndDimensions(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := slidesFake(t, map[string]string{
		"GET /v1/presentations/p2": `{"presentationId":"p2","slides":[]}`,
		"GET /v1/presentations/p3": `{"presentationId":"p3","title":"","pageSize":{"width":{"magnitude":7000000.5}},"slides":[{"objectId":"only","pageElements":[{"shape":{"placeholder":{"type":"TITLE"},"text":{"textElements":[]}}},{"shape":{"placeholder":{"type":"TITLE"},"text":{"textElements":[{"textRun":{"content":"Second"}}]}}}]}]}`,
	})
	v, err := product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"id-or-url": "https://docs.google.com/presentation/d/p1/edit#slide=id.s1"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if h := fake.Recorded()[0]; h.Method != "GET" || h.Path != "/v1/presentations/p1" {
		t.Fatalf("%s %s", h.Method, h.Path)
	}
	want := "ID: p1\nTitle: Quarterly Review\nURL: https://docs.google.com/presentation/d/p1\nSlides: 3\nDimensions: 10.00\" × 5.63\"\n\nSlide index:\n  [0] s1 — Hello — world\n  [1] s2\n  [2] s3 — Agenda\n"
	if got := product.Printed(t, "metadata", v, false); got != want {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(v); got != `{"id":"p1","title":"Quarterly Review","url":"https://docs.google.com/presentation/d/p1","slideCount":3,"width":9144000,"height":5143500,"slides":[{"index":0,"objectId":"s1","title":"Hello — world"},{"index":1,"objectId":"s2"},{"index":2,"objectId":"s3","title":"Agenda"}]}` {
		t.Fatal(got)
	}
	// No title falls back to Untitled; one dimension alone prints none; the
	// first TITLE placeholder wins even when it is empty.
	v, err = product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"id-or-url": "https://drive.google.com/open?id=p3"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Printed(t, "metadata", v, false); got != "ID: p3\nTitle: Untitled\nURL: https://docs.google.com/presentation/d/p3\nSlides: 1\n\nSlide index:\n  [0] only\n" {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(v); got != `{"id":"p3","title":"Untitled","url":"https://docs.google.com/presentation/d/p3","slideCount":1,"width":7000000.5,"slides":[{"index":0,"objectId":"only"}]}` {
		t.Fatal(got)
	}
	v, err = product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"id-or-url": "p2"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Printed(t, "metadata", v, false); got != "ID: p2\nTitle: Untitled\nURL: https://docs.google.com/presentation/d/p2\nSlides: 0\n" {
		t.Fatalf("%q", got)
	}
}

func TestGetPrintsTextAndNotes(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := slidesFake(t, map[string]string{"GET /v1/presentations/p2": `{"presentationId":"p2"}`})
	get := func(id string, set map[string]any) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"id-or-url": id}, set))
	}
	v, err := get("p1", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "\n--- Slide 1 (s1) ---\nHello — world\nLine 1\nLine 2\n\nNotes:\nSpeaker notes\n" +
		"\n--- Slide 2 (s2) ---\n(no text content)\n" +
		"\n--- Slide 3 (s3) ---\nAgenda\npart A part B\n"
	if got := product.Printed(t, "get", v, false); got != want {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(v); !strings.HasPrefix(got, `[{"index":0,"objectId":"s1","elements":[{"type":"text","text":"Hello — world"},{"type":"text","text":"Line 1\nLine 2"}],"notes":"Speaker notes"},{"index":1,"objectId":"s2","elements":[],"notes":""}`) {
		t.Fatal(got)
	}
	// parseInt keeps the leading digits.
	v, err = get("p1", map[string]any{"slide": "2.9"})
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Printed(t, "get", v, false); got != "\n--- Slide 3 (s3) ---\nAgenda\npart A part B\n" {
		t.Fatalf("%q", got)
	}
	v, err = get("p2", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := product.Printed(t, "get", v, false); got != "No slides found\n" || googletest.JSONText(v) != "[]" {
		t.Fatalf("%q %s", got, googletest.JSONText(v))
	}
	for _, c := range []struct {
		id, slide           string
		code                clierr.Code
		message, suggestion string
	}{
		{"p1", "3", clierr.InvalidParams, "Slide index 3 out of range (0–2)", "Use --slide 0 to 2"},
		{"p1", "-1", clierr.InvalidParams, "Slide index -1 out of range (0–2)", "Use --slide 0 to 2"},
		{"p2", "0", clierr.InvalidParams, "Slide index 0 out of range (0–-1)", "Use --slide 0 to -1"},
		// Bun reads allSlides[NaN] and fails on the undefined slide.
		{"p1", "abc", "API_ERROR", "Failed to get slide content: undefined is not an object (evaluating 'slide.pageElements')", ""},
		// parseInt("") is NaN too: a given empty --slide is not absent.
		{"p1", "", "API_ERROR", "Failed to get slide content: undefined is not an object (evaluating 'slide.pageElements')", ""},
	} {
		v, err := get(c.id, map[string]any{"slide": c.slide})
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%s --slide %s: %#v", c.id, c.slide, ce)
		}
	}
}

func TestCreateCopyAndExport(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := slidesFake(t, map[string]string{
		"POST /v1/presentations": `{"presentationId":"n1","title":"Q4 Review","slides":[]}`,
		"POST /files/p1/copy":    `{"id":"c1","name":"Q4 (copy)","webViewLink":"https://docs.google.com/presentation/d/c1/edit"}`,
		"POST /files/p2/copy":    `{"id":"c2"}`,
	})
	last := func() googletest.Hit { all := fake.Recorded(); return all[len(all)-1] }

	v, err := product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", map[string]any{"title": "Q4 Review"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "POST" || h.Path != "/v1/presentations" || googletest.JSONText(h.JSON) != `{"title":"Q4 Review"}` {
		t.Fatalf("%s %s %s", h.Method, h.Path, h.Raw)
	}
	if got := product.Printed(t, "create", v, false); got != "Presentation created\nID: n1\nTitle: Q4 Review\nURL: https://docs.google.com/presentation/d/n1\n" {
		t.Fatalf("%q", got)
	}
	// Bun sends { title } even when the title is empty.
	if _, err := product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", map[string]any{"title": ""}, nil)); err != nil {
		t.Fatal(err)
	}
	if h := last(); googletest.JSONText(h.JSON) != `{"title":""}` {
		t.Fatal(h.Raw)
	}

	v, err = product.Exec(fake.Ctx(), t, reg, "copy", product.Input(t, "copy", map[string]any{"id-or-url": "p1", "title": "Q4 (copy)"}, map[string]any{"parent": "f1"}))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("fields") != "id,name,webViewLink" || googletest.JSONText(h.JSON) != `{"name":"Q4 (copy)","parents":["f1"]}` {
		t.Fatalf("%v %s", h.Query, h.Raw)
	}
	if got := product.Printed(t, "copy", v, false); got != "Presentation created\nID: c1\nTitle: Q4 (copy)\nURL: https://docs.google.com/presentation/d/c1/edit\n" {
		t.Fatalf("%q", got)
	}
	v, err = product.Exec(fake.Ctx(), t, reg, "copy", product.Input(t, "copy", map[string]any{"id-or-url": "p2", "title": "Fallback"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); googletest.JSONText(h.JSON) != `{"name":"Fallback"}` || googletest.JSONText(v) != `{"id":"c2","title":"Fallback","url":"https://docs.google.com/presentation/d/c2"}` {
		t.Fatalf("%s %s", h.Raw, googletest.JSONText(v))
	}

	out := filepath.Join(t.TempDir(), "deck.pdf")
	v, err = product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"id-or-url": "p1"}, map[string]any{"output": out, "format": "PDF"}))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Path != "/files/p1/export" || h.Query.Get("mimeType") != "application/pdf" {
		t.Fatalf("%s %v", h.Path, h.Query)
	}
	if got, _ := os.ReadFile(out); string(got) != "PPTX" || product.Printed(t, "export", v, false) != "Exported to "+out+"\n  Format: pdf\n  Size: 4 bytes\n" {
		t.Fatalf("%q %v", got, v)
	}
	for format, mime := range map[string]string{"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "odp": "application/vnd.oasis.opendocument.presentation"} {
		if _, err := product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"id-or-url": "p1"}, map[string]any{"output": out, "format": format})); err != nil {
			t.Fatal(err)
		}
		if h := last(); h.Query.Get("mimeType") != mime {
			t.Fatal(h.Query)
		}
	}

	before := len(fake.Recorded())
	for _, c := range []struct {
		set                 map[string]any
		message, suggestion string
	}{
		{map[string]any{"format": "docx", "output": out}, "Unknown format: docx", "Use pptx, pdf, or odp"},
		{nil, "required option '--output <path>' not specified", ""},
	} {
		v, err := product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"id-or-url": "p1"}, c.set))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%#v", ce)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("an invalid export reached the API")
	}
}

func TestBatchForwardsTheRequestsVerbatim(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := slidesFake(t, map[string]string{
		"POST /v1/presentations/p1:batchUpdate": `{"presentationId":"p1","replies":[{},{"createSlide":{"objectId":"new"}}]}`,
	})
	requests := `[{"createSlide":{"insertionIndex":1.50,"slideLayoutReference":{"predefinedLayout":"BLANK"}}},{"futureRequest":{"b":false,"a":0}}]`
	file := filepath.Join(t.TempDir(), "requests.json")
	if err := os.WriteFile(file, []byte(requests), 0o600); err != nil {
		t.Fatal(err)
	}
	wantBody := `{"requests":[{"createSlide":{"insertionIndex":1.5,"slideLayoutReference":{"predefinedLayout":"BLANK"}}},{"futureRequest":{"b":false,"a":0}}]}`
	for _, set := range []map[string]any{{"requests-json": requests}, {"file": file}} {
		v, err := product.Exec(fake.Ctx(), t, reg, "batch", product.Input(t, "batch", map[string]any{"id-or-url": "https://docs.google.com/presentation/d/p1/edit"}, set))
		if err != nil {
			t.Fatal(err)
		}
		all := fake.Recorded()
		if h := all[len(all)-1]; h.Method != "POST" || h.Path != "/v1/presentations/p1:batchUpdate" || h.Raw != wantBody {
			t.Fatalf("%s %s %s", h.Method, h.Path, h.Raw)
		}
		if got := product.Printed(t, "batch", v, false); got != "Batch update applied to p1\n  Replies: 2\n" || googletest.JSONText(v) != `{"replies":2,"presentationId":"p1"}` {
			t.Fatalf("%q %s", got, googletest.JSONText(v))
		}
	}
	before := len(fake.Recorded())
	for _, c := range []struct {
		set     map[string]any
		message string
	}{
		{map[string]any{}, "Provide --requests-json or --file"},
		{map[string]any{"requests-json": "[]", "file": file}, "--requests-json and --file are mutually exclusive"},
		{map[string]any{"requests-json": "[{"}, "Invalid JSON: JSON Parse error: Expected '}'"},
		{map[string]any{"requests-json": `{"a":1}`}, "Input must be a JSON array of Request objects"},
		{map[string]any{"requests-json": "[]"}, "requests must be a non-empty array"},
	} {
		v, err := product.Exec(fake.Ctx(), t, reg, "batch", product.Input(t, "batch", map[string]any{"id-or-url": "p1"}, c.set))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message {
			t.Fatalf("%v: %#v", c.set, ce)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("an invalid batch reached the API")
	}
}

func TestExtractPresentationID(t *testing.T) {
	for in, want := range map[string]string{
		"p1": "p1",
		"https://docs.google.com/presentation/d/1A-b_C/edit#slide=id.p": "1A-b_C",
		"https://drive.google.com/open?id=Zz9":                          "Zz9",
		"https://docs.google.com/presentation/d/abc/edit?id=other":      "abc",
		"not a url!": "not a url!",
	} {
		if got := extractPresentationID(in); got != want {
			t.Errorf("%s: %s", in, got)
		}
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
	args := map[string]any{"id-or-url": "p1", "title": "T"}
	out := filepath.Join(t.TempDir(), "x.pptx")
	cmds := []struct {
		path, operation string
		set             map[string]any
	}{
		{"list", "list presentations", nil},
		{"metadata", "get presentation metadata", nil},
		{"get", "get slide content", map[string]any{"slide": "0"}},
		{"export", "export presentation", map[string]any{"output": out}},
		{"create", "create presentation", nil},
		{"copy", "copy presentation", nil},
		{"batch", "execute batch update", map[string]any{"requests-json": `[{"x":{}}]`}},
	}
	messages := map[int]struct {
		code    clierr.Code
		message string
	}{
		401: {clierr.AuthFailed, "OAuth token expired or invalid"},
		403: {clierr.PermissionDenied, "Insufficient permissions to access this presentation"},
		404: {clierr.NotFound, "Presentation not found"},
		400: {"API_ERROR", "Backend says no"},
	}
	for s, want := range messages {
		status = s
		for _, c := range cmds {
			v, err := product.Exec(fake.Ctx(), t, reg, c.path, product.Input(t, c.path, args, c.set))
			ce := googletest.CliErr(t, err)
			if v != nil || ce.Code != want.code || ce.Message != "Failed to "+c.operation+": "+want.message || ce.Suggestion != "" {
				t.Fatalf("%d %s: %v %#v", s, c.path, v, ce)
			}
		}
	}
	if _, err := os.Stat(out); err == nil {
		t.Fatal("a failed export wrote the file")
	}
}

// Commander treats --output "" as present; the export then fails in
// fs.promises.writeFile with Node's message, as a missing directory does.
func TestExportWriteFailsLikeNode(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) { _, _ = io.WriteString(w, "DATA") })
	missing := filepath.Join(t.TempDir(), "nodir", "out")
	for output, want := range map[string]string{
		"":      "ENOENT: no such file or directory, open",
		missing: "ENOENT: no such file or directory, open '" + missing + "'",
	} {
		v, err := product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"id-or-url": "x1"}, map[string]any{"output": output}))
		if v != nil || err == nil || err.Error() != want {
			t.Fatalf("%q: %v %v", output, v, err)
		}
	}
}
