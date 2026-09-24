package gsheets

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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

// storedCreds is a Bun GSheetsCredentials object (camelCase keys).
func storedCreds(expiry int64) map[string]any {
	return map[string]any{
		"accessToken":  "at-old",
		"refreshToken": "rt-old",
		"expiryDate":   expiry,
		"tokenType":    "Bearer",
		"scope":        "https://www.googleapis.com/auth/spreadsheets",
		"email":        "me@example.com",
	}
}

func fresh() map[string]any { return storedCreds(time.Now().Add(time.Hour).UnixMilli()) }

// The command table is the Bun surface: `bun run src/index.ts gsheets --help`
// and each leaf's --help.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op string
		format, accessFor       bool
	}
	want := map[string]row{
		"list":     {"", "--limit <n>=10 --query <query>", "read", "", true, false},
		"get":      {"<spreadsheet-id-or-url> <range>", "--dimension <dim> --render <opt>", "read", "", true, false},
		"update":   {"<spreadsheet-id-or-url> <range> [values...]", "--values-json <json> --input <opt>=USER_ENTERED", "write", "update values", true, true},
		"append":   {"<spreadsheet-id-or-url> <range> [values...]", "--values-json <json> --input <opt>=USER_ENTERED --insert <opt>", "write", "append values", true, true},
		"clear":    {"<spreadsheet-id-or-url> <range>", "", "write", "clear values", true, false},
		"format":   {"<spreadsheet-id-or-url> <range>", "--bold --italic --underline --font-size <n> --font-family <name> --text-color <hex> --background <hex> --align <pos> --valign <pos> --wrap <strategy> --number-format <pattern> --border <style> --merge --clear-format --raw <json>", "write", "format range", true, false},
		"resize":   {"<spreadsheet-id-or-url> <range>", "--size <pixels> --auto", "write", "resize range", true, false},
		"batch":    {"<spreadsheet-id-or-url>", "--requests-json <json> --file <path>", "write", "execute batch update", true, true},
		"metadata": {"<spreadsheet-id-or-url>", "", "read", "", true, false},
		"create":   {"<title>", "--sheets <names>", "write", "create spreadsheet", true, false},
		"copy":     {"<spreadsheet-id-or-url> <title>", "--parent <folder-id>", "write", "copy spreadsheet", true, false},
		"export":   {"<spreadsheet-id-or-url>", "--output <path> --format <fmt>=xlsx", "read", "", false, false},
	}
	p := New()
	if p.ID != "gsheets" || p.DisplayName != "Google Sheets" || p.Description != "Use when interacting with Google Sheets via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	var order []string
	for _, c := range p.Commands {
		order = append(order, c.Path)
	}
	if strings.Join(order, " ") != "list get update append clear format resize batch metadata create copy export" {
		t.Fatalf("order %v", order)
	}
	for _, c := range p.Commands {
		w, ok := want[c.Path]
		if !ok {
			t.Fatalf("unexpected command %q", c.Path)
		}
		var args, flags []string
		for _, a := range c.Arguments {
			name := a.Name
			if a.Variadic {
				name += "..."
			}
			if a.Required {
				args = append(args, "<"+name+">")
			} else {
				args = append(args, "["+name+"]")
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
		t.Fatal("gsheets is a camelCase Google lifecycle")
	}
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		switch h.Path {
		case "/token":
			googletest.WriteJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3599, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/spreadsheets"})
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
	wantScope := "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email"
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
	// camelCase, as GSheetsCredentials: a snake_case key would not open a Bun vault.
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
	if out.String() != "Profile \"user@example.com\" configured!\nEmail: user@example.com\nTest with: agentio gsheets list\n" {
		t.Fatalf("%q", out.String())
	}
	if len(logs) == 0 || logs[0] != "Starting OAuth flow for Google Sheets...\n" {
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
	if c, _ := vault.Load(); len(c.Credentials["gsheets"]) != 0 {
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
			_, errs[i] = auth.GetFresh(fake.Ctx(), reg, "gsheets", "acme", auth.RefreshOptions{})
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
		stored["legacy"] != "kept" || stored["scope"] != "https://www.googleapis.com/auth/spreadsheets" {
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
	_, err := product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"spreadsheet-id-or-url": "s1"}, nil))
	ce := googletest.CliErr(t, err)
	if ce.Code != clierr.TokenExpired || ce.Message != `Token refresh failed for gsheets profile "acme": invalid_grant` ||
		ce.Suggestion != "Re-authenticate with: agentio gsheets profile add --profile acme" {
		t.Fatalf("%#v", ce)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

// sheetsFake answers the Sheets and Drive calls the commands make with
// canned bodies; reply overrides a path.
func sheetsFake(t *testing.T, reply map[string]string) *googletest.Fake {
	return googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		if body, ok := reply[h.Method+" "+h.Path]; ok {
			googletest.WriteRaw(w, 200, body)
			return
		}
		switch {
		case h.Path == "/v4/spreadsheets/s1" && h.Method == "GET":
			googletest.WriteRaw(w, 200, `{"spreadsheetId":"s1","properties":{"title":"Plan"},"sheets":[{"properties":{"sheetId":0,"title":"Sheet1"}},{"properties":{"sheetId":7,"title":"Q'4"}}]}`)
		case strings.HasSuffix(h.Path, "/export"):
			_, _ = io.WriteString(w, "a,b\n")
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
	fake := sheetsFake(t, nil)
	args := map[string]any{"spreadsheet-id-or-url": "s1", "range": "Sheet1!A:B", "title": "T", "values": []string{"a|b"}}
	set := map[string]any{"bold": true, "size": "100", "requests-json": `[{"x":{}}]`}
	for path, op := range map[string]string{
		"update": "update values", "append": "append values", "clear": "clear values", "format": "format range",
		"resize": "resize range", "batch": "execute batch update", "create": "create spreadsheet", "copy": "copy spreadsheet",
	} {
		v, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, args, set))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio gsheets profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	// Bun checks the values and batch input before enforceWriteAccess.
	for path, message := range map[string]string{
		"update": "No values provided", "append": "No values provided", "batch": "Provide --requests-json or --file",
	} {
		_, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, map[string]any{"spreadsheet-id-or-url": "s1", "range": "A1"}, nil))
		if ce := googletest.CliErr(t, err); ce.Code != clierr.InvalidParams || ce.Message != message {
			t.Fatalf("%s: %#v", path, ce)
		}
	}
	out := filepath.Join(t.TempDir(), "x.xlsx")
	for _, path := range []string{"list", "get", "metadata", "export"} {
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
			h.Query.Get("q") != "mimeType='application/vnd.google-apps.spreadsheet'" {
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
	out := auth.RedactForRemote(reg, "gsheets", creds)
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
		if !strings.Contains(o.AuthorizationURL("http://localhost:3000/callback"), "auth%2Fspreadsheets") {
			t.Error("reauthenticate did not ask for the gsheets scopes")
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
	if strings.Join(logs, "|") != "\nRe-authenticating gsheets / work...|  Done (me@example.com)" {
		t.Fatalf("%q", logs)
	}
}

func TestListSendsTheBunQueryAndFormats(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := googletest.NewFake(t, func(w http.ResponseWriter, h googletest.Hit) {
		googletest.WriteJSON(w, 200, map[string]any{"files": []any{
			map[string]any{"id": "s1", "name": "Budget", "owners": []any{map[string]any{"displayName": "Ann"}}, "modifiedTime": "2024-02-01T00:00:00.000Z"},
			map[string]any{"id": "s2", "owners": []any{map[string]any{"emailAddress": "bob@example.com"}}, "webViewLink": "https://docs.google.com/spreadsheets/d/s2/edit"},
		}})
	})
	v, err := product.Exec(fake.Ctx(), t, reg, "list", product.Input(t, "list", nil, map[string]any{"limit": "250", "query": "name contains 'b'"}))
	if err != nil {
		t.Fatal(err)
	}
	h := fake.Recorded()[0]
	if h.Path != "/files" || h.Query.Get("pageSize") != "100" || h.Query.Get("q") != "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains 'b'" ||
		h.Query.Get("fields") != "files(id,name,owners,createdTime,modifiedTime,webViewLink)" || h.Query.Get("orderBy") != "modifiedTime desc" {
		t.Fatalf("%s %v", h.Path, h.Query)
	}
	want := "Spreadsheets (2)\n\n[1] Budget\n    ID: s1\n    Owner: Ann\n    Modified: 2024-02-01T00:00:00.000Z\n    Link: https://docs.google.com/spreadsheets/d/s1\n\n" +
		"[2] Untitled\n    ID: s2\n    Owner: bob@example.com\n    Link: https://docs.google.com/spreadsheets/d/s2/edit\n\n"
	if got := product.Printed(t, "list", v, false); got != want {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "list", []google.DriveFile{}, false); got != "No spreadsheets found\n" {
		t.Fatalf("%q", got)
	}
}

func TestValueCommandsSendTheBunRequestsAndPrintTheBunText(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := sheetsFake(t, map[string]string{
		"GET /v4/spreadsheets/s1/values/Sheet1!A1:B2":        `{"range":"Sheet1!A1:B2","majorDimension":"ROWS","values":[["a","1"],["b"],[]]}`,
		"GET /v4/spreadsheets/s1/values/Empty!A1":            `{"range":"Empty!A1","majorDimension":"ROWS"}`,
		"PUT /v4/spreadsheets/s1/values/Sheet1!A1:B2":        `{"spreadsheetId":"s1","updatedRange":"Sheet1!A1:B2","updatedRows":2,"updatedColumns":2,"updatedCells":4}`,
		"POST /v4/spreadsheets/s1/values/Sheet1!A:C:append":  `{"spreadsheetId":"s1","updates":{"updatedRange":"Sheet1!A5:C6","updatedRows":2,"updatedColumns":3,"updatedCells":6}}`,
		"POST /v4/spreadsheets/s1/values/Sheet1!A1:B2:clear": `{"spreadsheetId":"s1","clearedRange":"Sheet1!A1:B2"}`,
	})
	last := func() googletest.Hit { all := fake.Recorded(); return all[len(all)-1] }
	sheetURL := "https://docs.google.com/spreadsheets/d/s1/edit#gid=0"

	v, err := product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"spreadsheet-id-or-url": sheetURL, "range": `Sheet1\!A1:B2`}, map[string]any{"dimension": "COLUMNS", "render": "FORMULA"}))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "GET" || h.Query.Get("majorDimension") != "COLUMNS" || h.Query.Get("valueRenderOption") != "FORMULA" {
		t.Fatalf("%s %v", h.Method, h.Query)
	}
	if got := product.Printed(t, "get", v, false); got != "Range: Sheet1!A1:B2\n\na\t1\nb\n\n" {
		t.Fatalf("%q", got)
	}
	if got := product.Printed(t, "get", v, true); got != "{\n  \"range\": \"Sheet1!A1:B2\",\n  \"values\": [\n    [\n      \"a\",\n      \"1\"\n    ],\n    [\n      \"b\"\n    ],\n    []\n  ]\n}\n" {
		t.Fatalf("%q", got)
	}
	v, err = product.Exec(fake.Ctx(), t, reg, "get", product.Input(t, "get", map[string]any{"spreadsheet-id-or-url": "s1", "range": "Empty!A1"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); len(h.Query["majorDimension"]) != 0 || len(h.Query["valueRenderOption"]) != 0 {
		t.Fatalf("absent options sent: %v", h.Query)
	}
	if got := product.Printed(t, "get", v, false); got != "No data found\n" || googletest.JSONText(v) != `{"range":"Empty!A1","values":[]}` {
		t.Fatalf("%q %s", got, googletest.JSONText(v))
	}

	// Simple values: the words joined by a space, rows on ",", cells on "|", trimmed.
	v, err = product.Exec(fake.Ctx(), t, reg, "update", product.Input(t, "update", map[string]any{"spreadsheet-id-or-url": "s1", "range": "Sheet1!A1:B2", "values": []string{" a | b,c|d", "e "}}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "PUT" || h.Query.Get("valueInputOption") != "USER_ENTERED" || h.Raw != `{"values":[["a","b"],["c","d e"]]}` {
		t.Fatalf("%s %v %s", h.Method, h.Query, h.Raw)
	}
	if got := product.Printed(t, "update", v, false); got != "Updated 4 cells in Sheet1!A1:B2\n  Rows: 2\n  Columns: 2\n" {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(v); got != `{"updatedRange":"Sheet1!A1:B2","updatedRows":2,"updatedColumns":2,"updatedCells":4}` {
		t.Fatal(got)
	}
	// --values-json is sent as parsed: numbers, booleans, null and objects kept.
	if _, err := product.Exec(fake.Ctx(), t, reg, "update", product.Input(t, "update", map[string]any{"spreadsheet-id-or-url": "s1", "range": "Sheet1!A1:B2", "values": []string{"ignored"}},
		map[string]any{"values-json": `[[1.50,true,null,{"b":1,"a":2}],"row"]`, "input": "RAW"})); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("valueInputOption") != "RAW" || h.Raw != `{"values":[[1.5,true,null,{"b":1,"a":2}],"row"]}` {
		t.Fatalf("%v %s", h.Query, h.Raw)
	}

	v, err = product.Exec(fake.Ctx(), t, reg, "append", product.Input(t, "append", map[string]any{"spreadsheet-id-or-url": "s1", "range": "Sheet1!A:C", "values": []string{"x|y|z"}}, map[string]any{"insert": "INSERT_ROWS"}))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "POST" || h.Query.Get("valueInputOption") != "USER_ENTERED" || h.Query.Get("insertDataOption") != "INSERT_ROWS" || h.Raw != `{"values":[["x","y","z"]]}` {
		t.Fatalf("%s %v %s", h.Method, h.Query, h.Raw)
	}
	if got := product.Printed(t, "append", v, false); got != "Appended 6 cells to Sheet1!A5:C6\n  Rows: 2\n  Columns: 3\n" {
		t.Fatalf("%q", got)
	}
	// No updates in the reply: the requested range and zero counts.
	fake.SetHandle(func(w http.ResponseWriter, h googletest.Hit) { googletest.WriteRaw(w, 200, `{"spreadsheetId":"s1"}`) })
	v, err = product.Exec(fake.Ctx(), t, reg, "append", product.Input(t, "append", map[string]any{"spreadsheet-id-or-url": "s1", "range": "Sheet1!A:C", "values": []string{"x"}}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); len(h.Query["insertDataOption"]) != 0 {
		t.Fatalf("absent --insert sent: %v", h.Query)
	}
	if got := product.Printed(t, "append", v, false); got != "Appended 0 cells to Sheet1!A:C\n  Rows: 0\n  Columns: 0\n" {
		t.Fatalf("%q", got)
	}
	v, err = product.Exec(fake.Ctx(), t, reg, "clear", product.Input(t, "clear", map[string]any{"spreadsheet-id-or-url": "s1", "range": "Sheet1!A1:B2"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "POST" || h.Path != "/v4/spreadsheets/s1/values/Sheet1!A1:B2:clear" {
		t.Fatalf("%s %s", h.Method, h.Path)
	}
	if got := product.Printed(t, "clear", v, false); got != "Cleared Sheet1!A1:B2\n" {
		t.Fatalf("%q", got)
	}

	before := len(fake.Recorded())
	for _, c := range []struct {
		args       map[string]any
		set        map[string]any
		message    string
		suggestion string
	}{
		{nil, nil, "No values provided", "Provide values as args or via --values-json"},
		{nil, map[string]any{"values-json": "[1,"}, "Invalid JSON values: JSON Parse error: Unexpected EOF", ""},
		{nil, map[string]any{"values-json": `{"a":1}`}, "Invalid JSON values: JSON must be a 2D array", ""},
	} {
		args := map[string]any{"spreadsheet-id-or-url": "s1", "range": "A1"}
		for _, path := range []string{"update", "append"} {
			v, err := product.Exec(fake.Ctx(), t, reg, path, product.Input(t, path, args, c.set))
			ce := googletest.CliErr(t, err)
			if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggestion {
				t.Fatalf("%s %v: %#v", path, c.set, ce)
			}
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("invalid values reached the API")
	}
}

func TestFormatBuildsTheBunBatchUpdate(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := sheetsFake(t, nil)
	run := func(r string, set map[string]any) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "format", product.Input(t, "format", map[string]any{"spreadsheet-id-or-url": "s1", "range": r}, set))
	}
	v, err := run(`'Q''4'\!A1:D1`, map[string]any{
		"bold": true, "font-size": "12pt", "text-color": " #FFFFFF", "background": "#4285f4", "align": "Centre",
		"number-format": "0.00%", "border": "all", "merge": true, "clear-format": true,
		"raw": `{"textFormat":{"strikethrough":true},"padding":{"top":2}}`,
	})
	if err != nil {
		t.Fatal(err)
	}
	all := fake.Recorded()
	if all[0].Method != "GET" || all[0].Path != "/v4/spreadsheets/s1" || all[1].Method != "POST" || all[1].Path != "/v4/spreadsheets/s1:batchUpdate" {
		t.Fatalf("%v", all)
	}
	grid := `{"sheetId":7,"startRowIndex":0,"endRowIndex":1,"startColumnIndex":0,"endColumnIndex":4}`
	solid := `{"style":"SOLID"}`
	want := `{"requests":[` +
		`{"repeatCell":{"range":` + grid + `,"cell":{},"fields":"userEnteredFormat"}},` +
		`{"repeatCell":{"range":` + grid + `,"cell":{"userEnteredFormat":{"backgroundColor":{"red":0.25882352941176473,"green":0.5215686274509804,"blue":0.9568627450980393},"horizontalAlignment":"CENTER","numberFormat":{"type":"NUMBER","pattern":"0.00%"},"textFormat":{"strikethrough":true},"padding":{"top":2}}},` +
		`"fields":"userEnteredFormat.backgroundColor,userEnteredFormat.horizontalAlignment,userEnteredFormat.numberFormat,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.fontSize,userEnteredFormat.textFormat.foregroundColor,userEnteredFormat.padding"}},` +
		`{"updateBorders":{"range":` + grid + `,"top":` + solid + `,"bottom":` + solid + `,"left":` + solid + `,"right":` + solid + `,"innerHorizontal":` + solid + `,"innerVertical":` + solid + `}},` +
		`{"mergeCells":{"range":` + grid + `,"mergeType":"MERGE_ALL"}}]}`
	if all[1].Raw != want {
		t.Fatalf("body\n got %s\nwant %s", all[1].Raw, want)
	}
	wantText := "Formatted 'Q''4'!A1:D1\n  Sheet: Q'4\n  Cleared existing formatting\n" +
		"  Applied: backgroundColor, horizontalAlignment, numberFormat, textFormat.bold, textFormat.fontSize, textFormat.foregroundColor, padding, border:all\n  Merged: yes\n"
	if got := product.Printed(t, "format", v, false); got != wantText {
		t.Fatalf("%q", got)
	}

	// No sheet in the range: the first sheet, the whole grid; a NaN font size is null.
	v, err = run("A:B", map[string]any{"font-size": "big", "italic": true, "border": "OUTER", "wrap": "clip", "valign": "center"})
	if err != nil {
		t.Fatal(err)
	}
	all = fake.Recorded()
	want = `{"requests":[{"repeatCell":{"range":{"sheetId":0,"startColumnIndex":0,"endColumnIndex":2},"cell":{"userEnteredFormat":{"verticalAlignment":"MIDDLE","wrapStrategy":"CLIP","textFormat":{"italic":true,"fontSize":null}}},` +
		`"fields":"userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy,userEnteredFormat.textFormat.italic,userEnteredFormat.textFormat.fontSize"}},` +
		`{"updateBorders":{"range":{"sheetId":0,"startColumnIndex":0,"endColumnIndex":2},"top":{"style":"SOLID"},"bottom":{"style":"SOLID"},"left":{"style":"SOLID"},"right":{"style":"SOLID"}}}]}`
	if all[len(all)-1].Raw != want {
		t.Fatalf("body\n got %s\nwant %s", all[len(all)-1].Raw, want)
	}
	if got := googletest.JSONText(v); got != `{"range":"A:B","sheetTitle":"Sheet1","appliedFields":["verticalAlignment","wrapStrategy","textFormat.italic","textFormat.fontSize","border:outer"],"merged":false,"cleared":false}` {
		t.Fatal(got)
	}

	before := len(fake.Recorded())
	for _, c := range []struct {
		r                   string
		set                 map[string]any
		code                clierr.Code
		message, suggestion string
		calls               int
	}{
		{"A1", map[string]any{"align": "middle"}, clierr.InvalidParams, "Invalid --align value: middle", "Use left, center, or right", 0},
		{"A1", map[string]any{"valign": "left"}, clierr.InvalidParams, "Invalid --valign value: left", "Use top, middle, or bottom", 0},
		{"A1", map[string]any{"wrap": "none"}, clierr.InvalidParams, "Invalid --wrap value: none", "Use overflow, clip, or wrap", 0},
		{"A1", map[string]any{"border": "thick"}, clierr.InvalidParams, "Invalid --border value: thick", "Use all, outer, or none", 0},
		{"A1", map[string]any{"raw": "{"}, clierr.InvalidParams, "Invalid --raw JSON: JSON Parse error: Expected '}'", "", 0},
		{"A1", map[string]any{"raw": "[1]"}, clierr.InvalidParams, "--raw must be a JSON object (CellFormat)", "", 0},
		{"A1", map[string]any{"raw": "null"}, clierr.InvalidParams, "--raw must be a JSON object (CellFormat)", "", 0},
		// These are found after the sheet lookup, as in Bun.
		{"A1", nil, clierr.InvalidParams, "No formatting options specified", "Pass at least one format flag or --clear-format", 1},
		{"A1", map[string]any{"background": "#12345"}, clierr.InvalidParams, "Invalid hex color: #12345", "Use format #rrggbb (e.g., #ff0000)", 1},
		{"Nope!A1", map[string]any{"bold": true}, clierr.NotFound, "Sheet not found: Nope", "", 1},
		{"Sheet1!A1:1B", map[string]any{"bold": true}, clierr.InvalidParams, "Invalid cell reference: 1B", "Use A1 notation like A1, B2, or A:B", 1},
	} {
		n := len(fake.Recorded())
		v, err := run(c.r, c.set)
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != c.code || ce.Message != c.message || ce.Suggestion != c.suggestion || len(fake.Recorded())-n != c.calls {
			t.Fatalf("%s %v: %#v (%d calls)", c.r, c.set, ce, len(fake.Recorded())-n)
		}
	}
	for _, h := range fake.Recorded()[before:] {
		if h.Method != "GET" {
			t.Fatal("an invalid format reached batchUpdate")
		}
	}
}

func TestResizeBuildsTheBunDimensionRequest(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := sheetsFake(t, nil)
	run := func(r string, set map[string]any) (any, error) {
		return product.Exec(fake.Ctx(), t, reg, "resize", product.Input(t, "resize", map[string]any{"spreadsheet-id-or-url": "s1", "range": r}, set))
	}
	last := func() googletest.Hit { all := fake.Recorded(); return all[len(all)-1] }
	v, err := run("Sheet1!A:C", map[string]any{"size": "200"})
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Raw != `{"requests":[{"updateDimensionProperties":{"range":{"sheetId":0,"dimension":"COLUMNS","startIndex":0,"endIndex":3},"properties":{"pixelSize":200},"fields":"pixelSize"}}]}` {
		t.Fatal(h.Raw)
	}
	if got := product.Printed(t, "resize", v, false); got != "Resized 3 column(s) in Sheet1!A:C\n  Sheet: Sheet1\n  Size: 200px\n" {
		t.Fatalf("%q", got)
	}
	v, err = run("'Q''4'!2:5", map[string]any{"auto": true})
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Raw != `{"requests":[{"autoResizeDimensions":{"dimensions":{"sheetId":7,"dimension":"ROWS","startIndex":1,"endIndex":5}}}]}` {
		t.Fatal(h.Raw)
	}
	if got := product.Printed(t, "resize", v, false); got != "Resized 4 row(s) in 'Q''4'!2:5\n  Sheet: Q'4\n  Size: auto-fit\n" {
		t.Fatalf("%q", got)
	}
	if got := googletest.JSONText(v); got != `{"range":"'Q''4'!2:5","sheetTitle":"Q'4","dimension":"ROWS","count":4,"auto":true}` {
		t.Fatal(got)
	}
	// parseInt("wide") is NaN: JSON null, printed "NaNpx". A:10 is columns with an open end.
	v, err = run("Sheet1!A:10", map[string]any{"size": "wide"})
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Raw != `{"requests":[{"updateDimensionProperties":{"range":{"sheetId":0,"dimension":"COLUMNS","startIndex":0},"properties":{"pixelSize":null},"fields":"pixelSize"}}]}` {
		t.Fatal(h.Raw)
	}
	if got := product.Printed(t, "resize", v, false); got != "Resized 0 column(s) in Sheet1!A:10\n  Sheet: Sheet1\n  Size: NaNpx\n" || googletest.JSONText(v) != `{"range":"Sheet1!A:10","sheetTitle":"Sheet1","dimension":"COLUMNS","count":0,"pixelSize":null,"auto":false}` {
		t.Fatalf("%q %s", got, googletest.JSONText(v))
	}

	for _, c := range []struct {
		r       string
		set     map[string]any
		code    clierr.Code
		message string
		calls   int
	}{
		{"A:B", nil, clierr.InvalidParams, "Specify --size <pixels> or --auto", 0},
		{"A:B", map[string]any{"size": "1", "auto": true}, clierr.InvalidParams, "--size and --auto are mutually exclusive", 0},
		{"My Sheet", map[string]any{"auto": true}, clierr.InvalidParams, "Resize range must reference columns or rows (e.g. Sheet1!A:C or Sheet1!1:10)", 0},
		{"Sheet1!A1:B2", map[string]any{"auto": true}, clierr.InvalidParams, "Resize range must be columns-only (A:C) or rows-only (1:10), got A1:B2", 1},
		{"Nope!A:B", map[string]any{"auto": true}, clierr.NotFound, "Sheet not found: Nope", 1},
	} {
		n := len(fake.Recorded())
		v, err := run(c.r, c.set)
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != c.code || ce.Message != c.message || len(fake.Recorded())-n != c.calls {
			t.Fatalf("%s %v: %#v (%d calls)", c.r, c.set, ce, len(fake.Recorded())-n)
		}
	}
}

func TestBatchForwardsTheRequestsVerbatim(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := sheetsFake(t, map[string]string{
		"POST /v4/spreadsheets/s1:batchUpdate": `{"spreadsheetId":"s1","replies":[{},{"addSheet":{"properties":{"sheetId":9}}}]}`,
	})
	requests := `[{"updateSheetProperties":{"properties":{"sheetId":0,"gridProperties":{"frozenRowCount":1}},"fields":"gridProperties.frozenRowCount","hidden":false}},{"futureRequest":{"x":1.50}}]`
	file := filepath.Join(t.TempDir(), "requests.json")
	if err := os.WriteFile(file, []byte(requests), 0o600); err != nil {
		t.Fatal(err)
	}
	wantBody := `{"requests":[{"updateSheetProperties":{"properties":{"sheetId":0,"gridProperties":{"frozenRowCount":1}},"fields":"gridProperties.frozenRowCount","hidden":false}},{"futureRequest":{"x":1.5}}]}`
	for _, set := range []map[string]any{{"requests-json": requests}, {"file": file}} {
		v, err := product.Exec(fake.Ctx(), t, reg, "batch", product.Input(t, "batch", map[string]any{"spreadsheet-id-or-url": "https://docs.google.com/spreadsheets/d/s1/edit"}, set))
		if err != nil {
			t.Fatal(err)
		}
		all := fake.Recorded()
		if h := all[len(all)-1]; h.Method != "POST" || h.Path != "/v4/spreadsheets/s1:batchUpdate" || h.Raw != wantBody {
			t.Fatalf("%s %s %s", h.Method, h.Path, h.Raw)
		}
		if got := product.Printed(t, "batch", v, false); got != "Batch update applied to s1\n  Replies: 2\n" || googletest.JSONText(v) != `{"replies":2,"spreadsheetId":"s1"}` {
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
		v, err := product.Exec(fake.Ctx(), t, reg, "batch", product.Input(t, "batch", map[string]any{"spreadsheet-id-or-url": "s1"}, c.set))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message {
			t.Fatalf("%v: %#v", c.set, ce)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("an invalid batch reached the API")
	}
}

func TestMetadataCreateCopyAndExport(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", fresh(), false)
	fake := sheetsFake(t, map[string]string{
		"GET /v4/spreadsheets/s1": `{"spreadsheetId":"s1","properties":{"title":"Plan","locale":"en_US","timeZone":"Europe/Paris"},"sheets":[` +
			`{"properties":{"sheetId":0,"title":"Sheet1","gridProperties":{"rowCount":1000,"columnCount":26}}},{"properties":{"sheetId":5}}],"spreadsheetUrl":"https://docs.google.com/spreadsheets/d/s1/edit"}`,
		"GET /v4/spreadsheets/s2": `{"spreadsheetId":"s2","properties":{}}`,
		"POST /v4/spreadsheets":   `{"spreadsheetId":"n1","properties":{"title":"Budget"},"spreadsheetUrl":"https://docs.google.com/spreadsheets/d/n1/edit"}`,
		"POST /files/s1/copy":     `{"id":"c1","name":"Plan (copy)"}`,
	})
	last := func() googletest.Hit { all := fake.Recorded(); return all[len(all)-1] }

	v, err := product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"spreadsheet-id-or-url": "https://example.com/open?id=s1"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	want := "ID: s1\nTitle: Plan\nLocale: en_US\nTimeZone: Europe/Paris\nURL: https://docs.google.com/spreadsheets/d/s1/edit\n\nSheets:\n  [0] Sheet1 (1000 rows x 26 cols)\n  [5] Untitled (0 rows x 0 cols)\n"
	if got := product.Printed(t, "metadata", v, false); got != want {
		t.Fatalf("%q", got)
	}
	v, err = product.Exec(fake.Ctx(), t, reg, "metadata", product.Input(t, "metadata", map[string]any{"spreadsheet-id-or-url": "s2"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if got := googletest.JSONText(v); got != `{"id":"s2","title":"Untitled","url":"https://docs.google.com/spreadsheets/d/s2","sheets":[]}` {
		t.Fatal(got)
	}

	v, err = product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", map[string]any{"title": "Budget"}, map[string]any{"sheets": " Income , Expenses"}))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Method != "POST" || googletest.JSONText(h.JSON) != `{"properties":{"title":"Budget"},"sheets":[{"properties":{"title":"Income"}},{"properties":{"title":"Expenses"}}]}` {
		t.Fatalf("%s %s", h.Method, h.Raw)
	}
	if got := product.Printed(t, "create", v, false); got != "Spreadsheet created\nID: n1\nTitle: Budget\nURL: https://docs.google.com/spreadsheets/d/n1/edit\n" {
		t.Fatalf("%q", got)
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "create", product.Input(t, "create", map[string]any{"title": "Solo"}, nil)); err != nil {
		t.Fatal(err)
	}
	if h := last(); googletest.JSONText(h.JSON) != `{"properties":{"title":"Solo"}}` {
		t.Fatal(h.Raw)
	}

	v, err = product.Exec(fake.Ctx(), t, reg, "copy", product.Input(t, "copy", map[string]any{"spreadsheet-id-or-url": "s1", "title": "Plan (copy)"}, map[string]any{"parent": "f1"}))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("fields") != "id,name,webViewLink" || googletest.JSONText(h.JSON) != `{"name":"Plan (copy)","parents":["f1"]}` {
		t.Fatalf("%v %s", h.Query, h.Raw)
	}
	if got := product.Printed(t, "copy", v, false); got != "Spreadsheet created\nID: c1\nTitle: Plan (copy)\nURL: https://docs.google.com/spreadsheets/d/c1\n" {
		t.Fatalf("%q", got)
	}

	out := filepath.Join(t.TempDir(), "data.csv")
	v, err = product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"spreadsheet-id-or-url": "s1"}, map[string]any{"output": out, "format": "CSV"}))
	if err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Path != "/files/s1/export" || h.Query.Get("mimeType") != "text/csv" {
		t.Fatalf("%s %v", h.Path, h.Query)
	}
	if got, _ := os.ReadFile(out); string(got) != "a,b\n" || product.Printed(t, "export", v, false) != "Exported to "+out+"\n  Format: csv\n  Size: 4 bytes\n" {
		t.Fatalf("%q %v", got, v)
	}
	if _, err := product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"spreadsheet-id-or-url": "s1"}, map[string]any{"output": out})); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("mimeType") != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		t.Fatal(h.Query)
	}

	before := len(fake.Recorded())
	for _, c := range []struct {
		set                 map[string]any
		message, suggestion string
	}{
		{map[string]any{"format": "doc", "output": out}, "Unknown format: doc", "Use xlsx, pdf, csv, ods, or tsv"},
		{nil, "required option '--output <path>' not specified", ""},
	} {
		v, err := product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"spreadsheet-id-or-url": "s1"}, c.set))
		ce := googletest.CliErr(t, err)
		if v != nil || ce.Code != clierr.InvalidParams || ce.Message != c.message || ce.Suggestion != c.suggestion {
			t.Fatalf("%#v", ce)
		}
	}
	if len(fake.Recorded()) != before {
		t.Fatal("an invalid export reached the API")
	}
}

func TestA1ParsingIsBuns(t *testing.T) {
	for r, want := range map[string][2]string{
		"Sheet1!A1:B2": {"Sheet1", "A1:B2"},
		"'My ''Q'!C:C": {"My 'Q", "C:C"},
		"'!A1":         {"", "A1"},
		"Sheet1!":      {"Sheet1", ""},
		"b2:c":         {"", "b2:c"},
		"3:9":          {"", "3:9"},
		"5":            {"5", ""},
		"Data":         {"", "Data"},
		"My Sheet":     {"My Sheet", ""},
		"A:10":         {"A:10", ""},
	} {
		title, cells := parseA1Range(r)
		if title != want[0] || cells != want[1] {
			t.Errorf("%s: %q %q", r, title, cells)
		}
	}
	fail := func(_ plugins.ErrorCode, message, _ string) error { return errors.New(message) }
	show := func(p *int) string {
		if p == nil {
			return "-"
		}
		return strconv.Itoa(*p)
	}
	for cells, want := range map[string]string{
		"A1":       "0 1 0 1",
		"AA10:AB":  "9 - 26 28",
		"b:d":      "- - 1 4",
		"2:4":      "1 4 - -",
		"C3:":      "2 3 2 3",
		"A1:B2:C3": "0 2 0 2",
	} {
		b, err := parseCellRange(cells, fail)
		if err != nil {
			t.Fatal(err)
		}
		if got := strings.Join([]string{show(b.startRow), show(b.endRow), show(b.startCol), show(b.endCol)}, " "); got != want {
			t.Errorf("%s: %s", cells, got)
		}
	}
	for _, bad := range []string{":A1", "A1:?", "1A"} {
		if _, err := parseCellRange(bad, fail); err == nil || !strings.HasPrefix(err.Error(), "Invalid cell reference: ") {
			t.Errorf("%s: %v", bad, err)
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
	args := map[string]any{"spreadsheet-id-or-url": "s1", "range": "Sheet1!A:B", "title": "T", "values": []string{"a"}}
	out := filepath.Join(t.TempDir(), "x.xlsx")
	cmds := []struct {
		path, operation string
		set             map[string]any
	}{
		{"list", "list spreadsheets", nil},
		{"get", "get values", nil},
		{"update", "update values", nil},
		{"append", "append values", nil},
		{"clear", "clear values", nil},
		{"format", "format range", map[string]any{"bold": true}},
		{"resize", "resize dimension", map[string]any{"auto": true}},
		{"batch", "execute batch update", map[string]any{"requests-json": `[{"x":{}}]`}},
		{"metadata", "get metadata", nil},
		{"create", "create spreadsheet", nil},
		{"copy", "copy spreadsheet", nil},
		{"export", "export spreadsheet", map[string]any{"output": out}},
	}
	messages := map[int]struct {
		code    clierr.Code
		message string
	}{
		401: {clierr.AuthFailed, "OAuth token expired or invalid"},
		403: {clierr.PermissionDenied, "Insufficient permissions to access this spreadsheet"},
		404: {clierr.NotFound, "Spreadsheet not found"},
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
		v, err := product.Exec(fake.Ctx(), t, reg, "export", product.Input(t, "export", map[string]any{"spreadsheet-id-or-url": "x1"}, map[string]any{"output": output}))
		if v != nil || err == nil || err.Error() != want {
			t.Fatalf("%q: %v %v", output, v, err)
		}
	}
}
