package confluence

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/atlassian"
	"github.com/plosson/agentio/go/internal/plugins/atlassian/atlassiantest"
	"github.com/plosson/agentio/go/internal/vault"
)

var product = atlassiantest.For(New)

type hit = atlassiantest.Hit

var (
	writeJSON   = atlassiantest.WriteJSON
	storedCreds = atlassiantest.StoredCreds
	newFake     = atlassiantest.NewFake
)

// The command table is the Bun surface. A renamed flag, a lost default, or a
// write that turned into a read fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	p := New()
	if p.ID != "confluence" || p.DisplayName != "Confluence" || p.Description != "Use when interacting with Confluence via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	product.CheckCommands(t, map[string]atlassiantest.Row{
		"spaces":   {Flags: "--limit <number>=50 --type <type>", Access: "read"},
		"pages":    {Flags: "--space <key> --space-id <id> --parent <id> --limit <number>=25", Access: "read"},
		"get":      {Args: "<page-id>", Flags: "--format <format>=storage", Access: "read"},
		"search":   {Flags: "--cql <query> --space <key> --type <type> --text <text> --limit <number>=25", Access: "read"},
		"create":   {Flags: "--title <title>! --space <key> --space-id <id> --parent <id> --content <text>", Access: "write", Operation: "create page", Input: "text"},
		"update":   {Args: "<page-id>", Flags: "--title <title> --content <text>", Access: "write", Operation: "update page", Input: "text"},
		"comments": {Args: "<page-id>", Access: "read"},
		"comment":  {Args: "<page-id> [body]", Access: "write", Operation: "add comment", Input: "text"},
	})
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	product.SetupVault(t)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Host == "auth.atlassian.com" && h.Path == "/oauth/token":
			writeJSON(w, 200, map[string]any{"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600})
		case h.Host == "api.atlassian.com" && h.Path == "/oauth/token/accessible-resources":
			writeJSON(w, 200, []map[string]any{
				{"id": "c-a", "url": "https://alpha.atlassian.net", "name": "alpha", "scopes": []string{}},
				{"id": "c-b", "url": "https://beta.atlassian.net", "name": "beta", "scopes": []string{}},
			})
		default:
			w.WriteHeader(404)
		}
	})
	var opts plugins.OAuthSetupOptions
	var prompts []string
	sc := atlassiantest.SetupContext()
	sc.OAuth = func(_ context.Context, o plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		opts = o
		return plugins.OAuthSetupResult{Code: "code-1", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	sc.Select = func(message string, choices []plugins.Choice) (int, error) {
		q := message
		for _, c := range choices {
			q += " | " + c.Name + " - " + c.Description
		}
		prompts = append(prompts, q)
		return 1, nil
	}
	var out bytes.Buffer
	before := time.Now().UnixMilli()
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if opts.Port != 9999 || opts.ServiceName != "Atlassian" || opts.ExpectedState == "" {
		t.Fatalf("oauth opts %#v", opts)
	}
	authURL, _ := url.Parse(opts.AuthorizationURL("http://localhost:9999/callback"))
	q := authURL.Query()
	if authURL.Host != "auth.atlassian.com" || authURL.Path != "/authorize" ||
		q.Get("audience") != "api.atlassian.com" || q.Get("client_id") != atlassian.ClientID ||
		q.Get("scope") != "read:page:confluence write:page:confluence read:space:confluence read:comment:confluence write:comment:confluence search:confluence read:me offline_access" ||
		q.Get("redirect_uri") != "http://localhost:9999/callback" || q.Get("state") != opts.ExpectedState ||
		q.Get("response_type") != "code" || q.Get("prompt") != "consent" {
		t.Fatalf("authorize url %s", authURL)
	}
	secret, _ := obscure.Reveal(atlassian.SecretEnc)
	token := fake.Recorded()[0]
	if token.Body["grant_type"] != "authorization_code" || token.Body["client_id"] != atlassian.ClientID ||
		token.Body["client_secret"] != secret || secret == "" || token.Body["code"] != "code-1" ||
		token.Body["redirect_uri"] != "http://localhost:9999/callback" {
		t.Fatalf("token request %#v", token.Body)
	}
	if len(prompts) != 1 || prompts[0] != "Select a Confluence site: | alpha - https://alpha.atlassian.net | beta - https://beta.atlassian.net" {
		t.Fatalf("prompts %v", prompts)
	}
	// The suggested name is the site hostname, and the host saved it.
	stored := product.LoadCreds(t, "beta.atlassian.net")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "accessToken,cloudId,expiryDate,refreshToken,siteUrl" {
		t.Fatalf("keys %v", keys)
	}
	if stored["accessToken"] != "at-1" || stored["refreshToken"] != "rt-1" || stored["cloudId"] != "c-b" || stored["siteUrl"] != "https://beta.atlassian.net" {
		t.Fatalf("%#v", stored)
	}
	exp, ok := stored["expiryDate"].(json.Number)
	if !ok {
		t.Fatalf("expiryDate is %T, want a JSON number", stored["expiryDate"])
	}
	if n, _ := exp.Int64(); n < before+3600_000 || n > time.Now().UnixMilli()+3600_000 {
		t.Fatalf("expiry %d", n)
	}
	if !strings.Contains(out.String(), "Test with: agentio confluence spaces") {
		t.Fatal(out.String())
	}
}

func TestSetupRefusesWhenNoSiteOrNoTerminal(t *testing.T) {
	product.SetupVault(t)
	sites := []map[string]any{}
	newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			writeJSON(w, 200, map[string]any{"access_token": "a", "refresh_token": "r", "expires_in": 1})
			return
		}
		writeJSON(w, 200, sites)
	})
	sc := atlassiantest.SetupContext()
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	_, err := New().Profile.Setup(context.Background(), plugins.SetupOptions{}, sc)
	if err == nil || err.Error() != "No accessible Confluence sites found. Make sure your app has the correct permissions." {
		t.Fatalf("no sites: %v", err)
	}
	// Two sites and stdin at EOF is Bun's non-TTY interactiveSelect refusal.
	sites = []map[string]any{{"id": "1", "url": "https://a.atlassian.net", "name": "a"}, {"id": "2", "url": "https://b.atlassian.net", "name": "b"}}
	_, err = New().Profile.Setup(context.Background(), plugins.SetupOptions{}, sc)
	ce, ok := err.(*clierr.Error)
	if !ok || ce.Code != clierr.InvalidParams || ce.Message != "Interactive input required but not running in terminal" {
		t.Fatalf("non-tty: %#v", err)
	}
	c, _ := vault.Load()
	if len(c.Credentials["confluence"]) != 0 {
		t.Fatal("failed setup wrote the vault")
	}
}

func TestReauthenticateKeepsUnknownFields(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			writeJSON(w, 200, map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "expires_in": 60})
			return
		}
		writeJSON(w, 200, []map[string]any{{"id": "c-9", "url": "https://z.atlassian.net", "name": "z"}})
	})
	sc := atlassiantest.SetupContext()
	sc.OAuth = func(context.Context, plugins.OAuthSetupOptions) (plugins.OAuthSetupResult, error) {
		return plugins.OAuthSetupResult{Code: "c", RedirectURI: "http://localhost:9999/callback"}, nil
	}
	got, err := New().Profile.Reauthenticate(context.Background(), storedCreds(1), "p", sc)
	if err != nil {
		t.Fatal(err)
	}
	if got["legacyField"] != "kept" || got["accessToken"] != "at-2" || got["refreshToken"] != "rt-2" || got["cloudId"] != "c-9" || got["siteUrl"] != "https://z.atlassian.net" {
		t.Fatalf("%#v", got)
	}
}

func TestStaleTokenRefreshesOnceUnderConcurrentCallers(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(1), false)
	var mu sync.Mutex
	refreshes := 0
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			mu.Lock()
			refreshes++
			mu.Unlock()
			time.Sleep(50 * time.Millisecond)
			writeJSON(w, 200, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3600})
			return
		}
		writeJSON(w, 200, map[string]any{"results": []any{}})
	})
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = auth.GetFresh(context.Background(), reg, "confluence", "acme", auth.RefreshOptions{})
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
	secret, _ := obscure.Reveal(atlassian.SecretEnc)
	body := fake.Recorded()[0].Body
	if body["grant_type"] != "refresh_token" || body["refresh_token"] != "rt-old" || body["client_id"] != atlassian.ClientID || body["client_secret"] != secret {
		t.Fatalf("refresh request %#v", body)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-new" || stored["refreshToken"] != "rt-rotated" || stored["cloudId"] != "cloud-1" ||
		stored["siteUrl"] != "https://acme.atlassian.net" || stored["legacyField"] != "kept" {
		t.Fatalf("%#v", stored)
	}
	if _, ok := stored["expiryDate"].(json.Number); !ok {
		t.Fatalf("expiryDate %T", stored["expiryDate"])
	}
	// The command then calls the API with the refreshed token.
	if _, err := product.Exec(t, reg, "spaces", plugins.CommandInput{Options: map[string]any{"limit": "50"}}); err != nil {
		t.Fatal(err)
	}
	last := fake.Recorded()[len(fake.Recorded())-1]
	if last.Auth != "Bearer at-new" || refreshes != 1 {
		t.Fatalf("auth %q refreshes %d", last.Auth, refreshes)
	}
}

func TestRefreshKeepsTheOldRefreshTokenWhenNoneIsReturned(t *testing.T) {
	newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"access_token": "at-new", "expires_in": 10})
	})
	got, err := New().Profile.Refresh.Run(context.Background(), storedCreds(1))
	if err != nil {
		t.Fatal(err)
	}
	if got["refreshToken"] != "rt-old" || got["accessToken"] != "at-new" || got["legacyField"] != "kept" {
		t.Fatalf("%#v", got)
	}
}

func TestFailedRefreshLeavesTheVaultAndReportsTokenExpired(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(1), false)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if h.Path == "/oauth/token" {
			w.WriteHeader(403)
			_, _ = io.WriteString(w, `{"error":"invalid_grant"}`)
			return
		}
		t.Errorf("API called after a failed refresh: %s", h.Path)
	})
	_, err := product.Exec(t, reg, "spaces", plugins.CommandInput{Options: map[string]any{"limit": "50"}})
	ce, ok := err.(*clierr.Error)
	if !ok || ce.Code != clierr.TokenExpired ||
		ce.Message != `Token refresh failed for confluence profile "acme": Failed to refresh token: {"error":"invalid_grant"}` ||
		ce.Suggestion != "Re-authenticate with: agentio confluence profile add --profile acme" {
		t.Fatalf("%#v", err)
	}
	stored := product.LoadCreds(t, "acme")
	if stored["accessToken"] != "at-old" || stored["refreshToken"] != "rt-old" {
		t.Fatalf("vault changed: %#v", stored)
	}
	if len(fake.Recorded()) != 1 {
		t.Fatalf("%d requests", len(fake.Recorded()))
	}
}

func TestReadOnlyProfileRefusesWritesButRunsReads(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "ro", storedCreds(atlassiantest.Far()), true)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, 200, map[string]any{"results": []any{}})
	})
	for path, op := range map[string]string{"create": "create page", "update": "update page", "comment": "add comment"} {
		_, err := product.Exec(t, reg, path, plugins.CommandInput{
			Args:    map[string]any{"page-id": "1", "body": "hi"},
			Options: map[string]any{"title": "T", "space-id": "9", "content": "x"},
		})
		ce, ok := err.(*clierr.Error)
		if !ok || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot `+op+`: profile "ro" is read-only` ||
			ce.Suggestion != "To modify this profile's access: agentio confluence profile update --profile ro --no-read-only" {
			t.Fatalf("%s: %#v", path, err)
		}
	}
	// Bun checks the input before enforceWriteAccess: on a read-only profile
	// missing input is the input error. Commander's required --title is
	// present when given as "", so that one is refused.
	for _, c := range []struct {
		path string
		opts map[string]any
		args map[string]any
		code clierr.Code
		msg  string
	}{
		{"create", map[string]any{"space": "ENG", "content": "x"}, nil, clierr.InvalidParams, "required option '--title <title>' not specified"},
		{"create", map[string]any{"title": "T", "content": "x"}, nil, clierr.InvalidParams, "--space or --space-id is required"},
		{"create", map[string]any{"title": "T", "space": "ENG", "content": ""}, nil, clierr.InvalidParams, "Page body is required. Use --content or pipe via stdin."},
		{"create", map[string]any{"title": "", "space": "ENG", "content": "x"}, nil, clierr.PermissionDenied, `Cannot create page: profile "ro" is read-only`},
		{"update", map[string]any{}, map[string]any{"page-id": "1"}, clierr.InvalidParams, "Page body is required. Use --content or pipe via stdin."},
		{"comment", map[string]any{}, map[string]any{"page-id": "1"}, clierr.InvalidParams, "Comment body is required. Provide as argument or pipe via stdin."},
	} {
		_, err := product.Exec(t, reg, c.path, plugins.CommandInput{Args: c.args, Options: c.opts, Stdin: " \n"})
		ce, ok := err.(*clierr.Error)
		if !ok || ce.Code != c.code || ce.Message != c.msg {
			t.Fatalf("%s %v: %#v", c.path, c.opts, err)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("a refused write reached the API %d times", n)
	}
	if _, err := product.Exec(t, reg, "comments", plugins.CommandInput{Args: map[string]any{"page-id": "1"}}); err != nil {
		t.Fatal(err)
	}
	if n := len(fake.Recorded()); n != 1 {
		t.Fatalf("read did not run: %d", n)
	}
}

func TestValidate(t *testing.T) {
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, `{"results":[]}`)
	})
	run := host.NewRunContext(storedCreds(1), "acme", context.Background())
	res, err := validate(context.Background(), run)
	if err != nil || !res.Valid || res.Info != "https://acme.atlassian.net" {
		t.Fatalf("%#v %v", res, err)
	}
	h := fake.Recorded()[0]
	if h.Path != "/ex/confluence/cloud-1/wiki/api/v2/spaces" || h.Query.Get("limit") != "1" || h.Auth != "Bearer at-old" {
		t.Fatalf("%#v", h)
	}
	status = 401
	res, err = validate(context.Background(), run)
	if err != nil || res.Valid || res.Error != "API returned 401" {
		t.Fatalf("%#v %v", res, err)
	}
}

func TestRemoteRedactionDropsTheRefreshTokenOnly(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds(1)
	out := auth.RedactForRemote(reg, "confluence", creds)
	if _, ok := out["refreshToken"]; ok {
		t.Fatal("refreshToken leaked to a remote caller")
	}
	if out["accessToken"] != "at-old" || out["cloudId"] != "cloud-1" || creds["refreshToken"] != "rt-old" {
		t.Fatalf("%#v / %#v", out, creds)
	}
}

func TestStaleFollowsTheBunComparison(t *testing.T) {
	cases := []struct {
		name  string
		creds map[string]any
		want  bool
	}{
		{"missing expiry is never stale", map[string]any{"refreshToken": "r"}, false},
		{"null expiry coerces to 0", map[string]any{"expiryDate": nil}, true},
		{"inside the buffer", map[string]any{"expiryDate": json.Number("1400")}, true},
		{"exactly at the buffer edge", map[string]any{"expiryDate": json.Number("1500")}, true},
		{"beyond the buffer", map[string]any{"expiryDate": json.Number("1501")}, false},
	}
	for _, c := range cases {
		if got := New().Profile.Refresh.IsStale(c.creds, 1000, 500); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
	if New().Profile.Refresh.Applies(map[string]any{"refreshToken": ""}) || New().Profile.Refresh.Applies(map[string]any{"refreshToken": 5}) || !New().Profile.Refresh.Applies(map[string]any{"refreshToken": "r"}) {
		t.Fatal("applies")
	}
}

func TestCommandsSendTheBunRequests(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(atlassiantest.Far()), false)
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		switch {
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/spaces" && h.Query.Get("keys") == "NOPE":
			writeJSON(w, 200, map[string]any{"results": []any{}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/spaces" && h.Query.Get("keys") != "":
			writeJSON(w, 200, map[string]any{"results": []any{map[string]any{"id": "77", "key": "ENG", "name": "Eng", "type": "global", "status": "current"}}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/pages/5" && h.Method == "GET":
			writeJSON(w, 200, map[string]any{"id": "5", "title": "Old", "spaceId": "77", "status": "current", "createdAt": "t", "version": map[string]any{"number": 4}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/pages/5" && h.Method == "PUT":
			writeJSON(w, 200, map[string]any{"id": "5", "title": "Old", "version": map[string]any{"number": 5}})
		case h.Path == "/ex/confluence/cloud-1/wiki/api/v2/pages/404":
			w.WriteHeader(404)
			_, _ = io.WriteString(w, `{"message":"gone"}`)
		case h.Method == "POST":
			writeJSON(w, 200, map[string]any{"id": "900", "title": "T", "spaceId": "77", "_links": map[string]any{"webui": "/spaces/ENG/pages/900"}})
		default:
			writeJSON(w, 200, map[string]any{"results": []any{}})
		}
	})
	last := func() hit { r := fake.Recorded(); return r[len(r)-1] }
	opts := func(kv ...string) map[string]any {
		m := map[string]any{"profile": "acme"}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}

	// spaces: limit is parseInt'ed; NaN is sent as Bun sends it.
	if _, err := product.Exec(t, reg, "spaces", plugins.CommandInput{Options: opts("limit", "10abc", "type", "global")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("limit") != "10" || h.Query.Get("type") != "global" {
		t.Fatalf("spaces %v", h.Query)
	}
	if _, err := product.Exec(t, reg, "spaces", plugins.CommandInput{Options: opts("limit", "x")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("limit") != "NaN" || h.Query.Has("type") {
		t.Fatalf("spaces NaN %v", h.Query)
	}
	// A given --limit "" is parseInt("") = NaN too, as Bun sends it (spaces,
	// pages and search: `limit=NaN`, not the default).
	for _, c := range []struct {
		path string
		opts map[string]any
		want url.Values
	}{
		{"spaces", opts("limit", ""), url.Values{"limit": {"NaN"}}},
		{"pages", opts("limit", ""), url.Values{"limit": {"NaN"}}},
		{"search", opts("text", "q", "limit", ""), url.Values{"cql": {`text ~ "q"`}, "limit": {"NaN"}}},
	} {
		if _, err := product.Exec(t, reg, c.path, plugins.CommandInput{Options: c.opts}); err != nil {
			t.Fatal(err)
		}
		if h := last(); h.Query.Encode() != c.want.Encode() {
			t.Fatalf("%s --limit \"\": %v", c.path, h.Query)
		}
	}

	// pages: a space key is resolved to its id first.
	if _, err := product.Exec(t, reg, "pages", plugins.CommandInput{Options: opts("space", "ENG", "parent", "3", "limit", "25")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Path != "/ex/confluence/cloud-1/wiki/api/v2/spaces/77/pages" || h.Query.Get("parent-id") != "3" || h.Query.Get("limit") != "25" {
		t.Fatalf("pages %#v", h)
	}
	_, err := product.Exec(t, reg, "pages", plugins.CommandInput{Options: opts("space", "NOPE", "limit", "25")})
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != "NOT_FOUND" || ce.Message != `Space "NOPE" not found` {
		t.Fatalf("missing space %#v", err)
	}

	// search: CQL is joined the Bun way and quotes in --text are escaped.
	if _, err := product.Exec(t, reg, "search", plugins.CommandInput{Options: opts("cql", "title ~ 'API'", "space", "ENG", "type", "page", "text", `say "hi"`, "limit", "5")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Path != "/ex/confluence/cloud-1/wiki/rest/api/search" ||
		h.Query.Get("cql") != `title ~ 'API' AND space.key = "ENG" AND type = "page" AND text ~ "say \"hi\""` || h.Query.Get("limit") != "5" {
		t.Fatalf("search %#v", h)
	}
	// The query string is URLSearchParams': `~` escaped, `*` not.
	if _, err := product.Exec(t, reg, "search", plugins.CommandInput{Options: opts("text", "a~b*(c)", "limit", "25")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.RawQuery != "cql=text+%7E+%22a%7Eb*%28c%29%22&limit=25" {
		t.Fatalf("search query %q", h.RawQuery)
	}
	if _, err := product.Exec(t, reg, "search", plugins.CommandInput{Options: opts("limit", "25")}); err != nil {
		t.Fatal(err)
	}
	if h := last(); h.Query.Get("cql") != `type = "page" ORDER BY lastmodified DESC` {
		t.Fatalf("default cql %v", h.Query)
	}

	// create: body from stdin is trimmed, escaped, and wrapped as storage.
	res, err := product.Exec(t, reg, "create", plugins.CommandInput{Options: opts("title", "T", "space", "ENG"), Stdin: "a & <b>\nline\n\nnext\n"})
	if err != nil {
		t.Fatal(err)
	}
	h := last()
	wantBody := map[string]any{"representation": "storage", "value": "<p>a &amp; &lt;b&gt;<br/>line</p><p>next</p>"}
	if h.Path != "/ex/confluence/cloud-1/wiki/api/v2/pages" || h.Body["spaceId"] != "77" || h.Body["status"] != "current" ||
		h.Body["title"] != "T" || !jsonEqual(h.Body["body"], wantBody) {
		t.Fatalf("create %#v", h.Body)
	}
	if _, has := h.Body["parentId"]; has {
		t.Fatal("parentId sent although --parent was not given")
	}
	// A given --parent "" is sent as Bun sends it: "parentId":"".
	if _, err := product.Exec(t, reg, "create", plugins.CommandInput{Options: opts("title", "T", "space-id", "9", "parent", "", "content", "x")}); err != nil {
		t.Fatal(err)
	}
	if h = last(); !jsonEqual(h.Body, map[string]any{"spaceId": "9", "status": "current", "title": "T", "parentId": "",
		"body": map[string]any{"representation": "storage", "value": "<p>x</p>"}}) {
		t.Fatalf("create --parent \"\" %s", h.Raw)
	}
	if formatCreated(res) != "Page created\nID: 900\nTitle: T\nSpace: 77\nLink: https://acme.atlassian.net/wiki/spaces/ENG/pages/900" {
		t.Fatalf("%q", formatCreated(res))
	}

	// update: keeps the current title, bumps the version.
	if _, err := product.Exec(t, reg, "update", plugins.CommandInput{Args: map[string]any{"page-id": "5"}, Options: opts("content", "new")}); err != nil {
		t.Fatal(err)
	}
	h = last()
	if h.Method != "PUT" || h.Body["title"] != "Old" || h.Body["status"] != "current" || h.Body["id"] != "5" ||
		!jsonEqual(h.Body["version"], map[string]any{"number": 5}) {
		t.Fatalf("update %#v", h.Body)
	}
	// Bun `params.title ?? current.title`: a given --title "" is sent as is.
	if _, err := product.Exec(t, reg, "update", plugins.CommandInput{Args: map[string]any{"page-id": "5"}, Options: opts("content", "new", "title", "")}); err != nil {
		t.Fatal(err)
	}
	if h = last(); h.Body["title"] != "" {
		t.Fatalf("update --title \"\" %#v", h.Body)
	}

	// comment: the argument wins over stdin.
	if _, err := product.Exec(t, reg, "comment", plugins.CommandInput{Args: map[string]any{"page-id": "5", "body": "arg"}, Options: opts(), Stdin: "stdin"}); err != nil {
		t.Fatal(err)
	}
	h = last()
	if h.Path != "/ex/confluence/cloud-1/wiki/api/v2/footer-comments" || h.Body["pageId"] != "5" ||
		!jsonEqual(h.Body["body"], map[string]any{"representation": "storage", "value": "<p>arg</p>"}) {
		t.Fatalf("comment %#v", h.Body)
	}

	// An API failure maps the status and keeps Atlassian's body.
	_, err = product.Exec(t, reg, "get", plugins.CommandInput{Args: map[string]any{"page-id": "404"}, Options: opts("format", "storage")})
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != "NOT_FOUND" || ce.Message != `Confluence API error: {"message":"gone"}` || ce.Suggestion != "" {
		t.Fatalf("404 %#v", err)
	}
}

func TestInputErrorsMatchBun(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(atlassiantest.Far()), false)
	fake := newFake(t, func(w http.ResponseWriter, h hit) { writeJSON(w, 200, map[string]any{}) })
	cases := []struct {
		path string
		in   plugins.CommandInput
		msg  string
	}{
		{"get", plugins.CommandInput{Args: map[string]any{"page-id": "1"}, Options: map[string]any{"format": "html"}},
			`Invalid format "html". Use storage, atlas_doc_format, or view.`},
		{"create", plugins.CommandInput{Options: map[string]any{"title": "T", "content": "x"}}, "--space or --space-id is required"},
		{"create", plugins.CommandInput{Options: map[string]any{"title": "T", "space": "ENG"}, Stdin: "  \n"},
			"Page body is required. Use --content or pipe via stdin."},
		{"update", plugins.CommandInput{Args: map[string]any{"page-id": "1"}, Options: map[string]any{}},
			"Page body is required. Use --content or pipe via stdin."},
		{"comment", plugins.CommandInput{Args: map[string]any{"page-id": "1"}, Options: map[string]any{}},
			"Comment body is required. Provide as argument or pipe via stdin."},
	}
	for _, c := range cases {
		_, err := product.Exec(t, reg, c.path, c.in)
		ce, ok := err.(*clierr.Error)
		if !ok || ce.Code != clierr.InvalidParams || ce.Message != c.msg {
			t.Errorf("%s: %#v", c.path, err)
		}
	}
	if n := len(fake.Recorded()); n != 0 {
		t.Fatalf("invalid input reached the API %d times", n)
	}
	// No profile at all is the host's error, not a crash in the client.
	product.SetupVault(t)
	_, err := product.Exec(t, reg, "spaces", plugins.CommandInput{Options: map[string]any{"profile": "ghost"}})
	if atlassiantest.CliErr(t, err).Code != clierr.ProfileNotFound {
		t.Fatalf("%#v", err)
	}
}

func parsed(t *testing.T, raw string) any {
	t.Helper()
	v, err := jsvalue.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestResponseMappingAndFormat(t *testing.T) {
	a := api{siteURL: "https://acme.atlassian.net/"}
	// search: content fields win, then the top-level title, then "(untitled)".
	results, err := mapItems(parsed(t, `[
		{"content":{"id":"1","type":"page","title":"Doc","space":{"key":"ENG"}},"excerpt":"<b>x</b> &amp; y","url":"/spaces/ENG/pages/1","lastModified":"2024-01-01"},
		{"title":"Loose"},
		{"content":{"id":"3","title":""}}
	]`), "r", a.searchModel)
	if err != nil {
		t.Fatal(err)
	}
	want := "Results (3)\n\n" +
		"[page] 1 | Doc\n    Space: ENG\n    Modified: 2024-01-01\n    Link: https://acme.atlassian.net/wiki/spaces/ENG/pages/1\n    > x & y\n\n" +
		"[unknown]  | Loose\n\n" +
		"[unknown] 3 | \n"
	if got := formatSearch(results); got != want {
		t.Fatalf("search\n%q\n%q", got, want)
	}
	if formatSearch([]any{}) != "No results" || formatSpaces([]any{}) != "No spaces found" ||
		formatPages([]any{}) != "No pages found" || formatComments([]any{}) != "No comments" {
		t.Fatal("empty lists")
	}
	// A comment with no body still prints its preview line, as Bun does.
	comment := parsed(t, `{"id":"c1","version":2,"createdAt":"t","body":""}`)
	if got := formatComments([]any{comment}); got != "Comments (1)\n\n[c1] v2 t\n    > \n" {
		t.Fatalf("%q", got)
	}
	// Truncation counts UTF-16 units like String.prototype.slice.
	if jsvalue.Truncate(strings.Repeat("😀", 60), 100) != strings.Repeat("😀", 50)+"..." {
		t.Fatal("utf16 truncate")
	}
	// ADF bodies flatten blocks with blank lines and hard breaks with newlines.
	adf := parsed(t, `{"type":"doc","content":[
		{"type":"paragraph","content":[{"type":"text","text":"a"},{"type":"hardBreak"},{"type":"text","text":"b"}]},
		{"type":"paragraph","content":[{"type":"text","text":"c"}]}]}`)
	if atlassian.ExtractTextFromADF(adf) != "a\nb\n\nc" {
		t.Fatalf("%q", atlassian.ExtractTextFromADF(adf))
	}
	if stripHTML("<p>one</p>  <p class='x'>two<br/>three</p>\n\n\n\n&quot;q&quot;&#39;&nbsp;") != "one\n\ntwo\nthree\n\n\"q\"'" {
		t.Fatalf("%q", stripHTML("<p>one</p>  <p class='x'>two<br/>three</p>\n\n\n\n&quot;q&quot;&#39;&nbsp;"))
	}
}

// Fields Confluence leaves out read as JavaScript reads them: "undefined" in
// the text, Bun's TypeError where it dereferences them, null for an empty
// body, and `v + 1` for the next version. Expectations are Bun's output
// against the same answers (a local mock through the CLI).
func TestMissingFieldsReadAsBunReadsThem(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(atlassiantest.Far()), false)
	page := map[string]any{"page-id": "1"}
	opts := func(kv ...string) map[string]any {
		m := map[string]any{}
		for i := 0; i+1 < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return m
	}
	cases := []struct {
		answer  string
		path    string
		in      plugins.CommandInput
		out     string
		errText string
		sent    string
	}{
		{"", "spaces", plugins.CommandInput{Options: opts("limit", "50")}, "", "null is not an object (evaluating '(await this.request(\"GET\", this.baseV2, `/spaces?${params.toString()}`)).results')", ""},
		{`{"results":[null]}`, "spaces", plugins.CommandInput{Options: opts("limit", "50")}, "", `null is not an object (evaluating 's.id')`, ""},
		{`{"results":[{"description":{"plain":{"value":5}}}]}`, "spaces", plugins.CommandInput{Options: opts("limit", "50")},
			"Spaces (1)\n\nundefined - undefined\n    ID: undefined\n    Type: undefined | Status: undefined\n    > 5\n", "", ""},
		{"", "pages", plugins.CommandInput{Options: opts("limit", "25")}, "", `null is not an object (evaluating '(await this.request("GET", this.baseV2, path)).results')`, ""},
		{`{"results":[null]}`, "pages", plugins.CommandInput{Options: opts("limit", "25")}, "", `null is not an object (evaluating 'p.id')`, ""},
		{`{"results":[{}]}`, "pages", plugins.CommandInput{Options: opts("limit", "25")}, "", `undefined is not an object (evaluating 'p.version.number')`, ""},
		{`{"results":[{"version":{},"_links":{"webui":"/x"}}]}`, "pages", plugins.CommandInput{Options: opts("limit", "25")},
			"Pages (1)\n\nundefined | undefined\n    Space: undefined | Status: undefined | vundefined\n    Created: undefined\n    Link: https://acme.atlassian.net/wiki/x\n", "", ""},
		{`{"results":[null]}`, "pages", plugins.CommandInput{Options: opts("limit", "25", "space", "SP")}, "", `Space "SP" not found`, ""},
		{"null", "pages", plugins.CommandInput{Options: opts("limit", "25", "space", "123")}, "", `null is not an object (evaluating 's.id')`, ""},
		{"{}", "pages", plugins.CommandInput{Options: opts("limit", "25", "space", "123")}, "", `undefined is not an object (evaluating '(await this.request("GET", this.baseV2, path)).results.map')`, ""},
		{"", "get", plugins.CommandInput{Args: page, Options: opts("format", "storage")}, "", `null is not an object (evaluating 'response.body')`, ""},
		{"{}", "get", plugins.CommandInput{Args: page, Options: opts("format", "storage")}, "", `undefined is not an object (evaluating 'response.version.number')`, ""},
		{`{"version":{}}`, "get", plugins.CommandInput{Args: page, Options: opts("format", "atlas_doc_format")},
			"ID: undefined\nTitle: undefined\nSpace: undefined\nStatus: undefined\nVersion: undefined\nCreated: undefined", "", ""},
		{`{"version":{"number":2},"body":{"atlas_doc_format":{"value":"nope"}}}`, "get", plugins.CommandInput{Args: page, Options: opts("format", "atlas_doc_format")},
			"ID: undefined\nTitle: undefined\nSpace: undefined\nStatus: undefined\nVersion: 2\nCreated: undefined\n---\nnope", "", ""},
		{`{"results":[null]}`, "comments", plugins.CommandInput{Args: page}, "", `null is not an object (evaluating 'c.id')`, ""},
		{`{"results":[{}]}`, "comments", plugins.CommandInput{Args: page}, "", `undefined is not an object (evaluating 'c.version.number')`, ""},
		{`{"results":[{"version":{}}]}`, "comments", plugins.CommandInput{Args: page}, "Comments (1)\n\n[undefined] vundefined undefined\n    > \n", "", ""},
		{`{"results":[null]}`, "search", plugins.CommandInput{Options: opts("limit", "25")}, "", `null is not an object (evaluating 'r.content')`, ""},
		{`{"results":[{}]}`, "search", plugins.CommandInput{Options: opts("limit", "25")}, "Results (1)\n\n[unknown]  | (untitled)\n", "", ""},
		{`{"version":{}}`, "update", plugins.CommandInput{Args: page, Options: opts("content", "C")}, "Page updated\nID: undefined\nTitle: undefined\nVersion: undefined", "",
			`{"id":"1","body":{"representation":"storage","value":"<p>C</p>"},"version":{"number":null}}`},
		{`{"version":{"number":"3"}}`, "update", plugins.CommandInput{Args: page, Options: opts("content", "C")}, "Page updated\nID: undefined\nTitle: undefined\nVersion: 3", "",
			`{"id":"1","body":{"representation":"storage","value":"<p>C</p>"},"version":{"number":"31"}}`},
		{`{"version":{"number":null}}`, "update", plugins.CommandInput{Args: page, Options: opts("content", "C")}, "Page updated\nID: undefined\nTitle: undefined\nVersion: null", "",
			`{"id":"1","body":{"representation":"storage","value":"<p>C</p>"},"version":{"number":1}}`},
		{"{}", "create", plugins.CommandInput{Options: opts("title", "T", "space-id", "9", "content", "C")}, "Page created\nID: undefined\nTitle: undefined\nSpace: undefined", "",
			`{"spaceId":"9","status":"current","title":"T","body":{"representation":"storage","value":"<p>C</p>"}}`},
		{"null", "create", plugins.CommandInput{Options: opts("title", "T", "space-id", "9", "content", "C")}, "", `null is not an object (evaluating 'response.id')`, ""},
		{"{}", "comment", plugins.CommandInput{Args: map[string]any{"page-id": "1", "body": "hi"}}, "Comment added\nPage: 1\nComment ID: undefined", "",
			`{"pageId":"1","body":{"representation":"storage","value":"<p>hi</p>"}}`},
		{"", "comment", plugins.CommandInput{Args: map[string]any{"page-id": "1", "body": "hi"}}, "",
			"null is not an object (evaluating '(await this.request(\"POST\", this.baseV2, \"/footer-comments\", {\n        pageId,\n        body: {\n          representation: \"storage\",\n          value: storage\n        }\n      })).id')", ""},
	}
	for _, c := range cases {
		fake := atlassiantest.NewFake(t, func(w http.ResponseWriter, h hit) { atlassiantest.WriteRaw(w, 200, c.answer) })
		in := c.in
		in.Options = map[string]any{"profile": "acme"}
		for k, v := range c.in.Options {
			in.Options[k] = v
		}
		res, err := product.Exec(t, reg, c.path, in)
		out := ""
		if res != nil {
			out = product.Spec(t, c.path).Format(res)
		}
		errText := ""
		if err != nil {
			errText = err.Error()
		}
		if out != c.out || errText != c.errText {
			t.Errorf("%s %q:\nout %q\nerr %q", c.path, c.answer, out, errText)
		}
		if c.sent != "" {
			if h := fake.Last(); h.Raw != c.sent {
				t.Errorf("%s %q sent %s", c.path, c.answer, h.Raw)
			}
		}
	}
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

// A failed call returns no value: the CLI prints a value returned with an
// error, and Bun printed nothing before throwing (no empty page, no "No
// spaces found").
func TestFailedCallReturnsNoValue(t *testing.T) {
	reg := product.SetupVault(t)
	product.SaveProfile(t, "acme", storedCreds(atlassiantest.Far()), false)
	newFake(t, func(w http.ResponseWriter, _ hit) { writeJSON(w, 500, map[string]any{"message": "boom"}) })
	page := map[string]any{"page-id": "1"}
	for _, c := range []struct {
		path string
		in   plugins.CommandInput
	}{
		{"spaces", plugins.CommandInput{Options: map[string]any{"limit": "50"}}},
		{"pages", plugins.CommandInput{Options: map[string]any{"limit": "25", "space": "ENG"}}},
		{"get", plugins.CommandInput{Args: page, Options: map[string]any{"format": "storage"}}},
		{"search", plugins.CommandInput{Options: map[string]any{"limit": "25", "text": "x"}}},
		{"create", plugins.CommandInput{Options: map[string]any{"title": "T", "space-id": "9", "content": "x"}}},
		{"update", plugins.CommandInput{Args: page, Options: map[string]any{"content": "x"}}},
		{"comments", plugins.CommandInput{Args: page}},
		{"comment", plugins.CommandInput{Args: map[string]any{"page-id": "1", "body": "x"}}},
	} {
		v, err := product.Exec(t, reg, c.path, c.in)
		if err == nil || v != nil {
			t.Errorf("%s: value %#v with error %v", c.path, v, err)
		}
	}
}
