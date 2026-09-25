package discourse

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// hit is one request that reached the fake forum.
type hit struct {
	Method      string
	Path        string
	Query       url.Values
	APIKey      string
	APIUsername string
	ContentType string
}

type fakeForum struct {
	mu     sync.Mutex
	hits   []hit
	url    string
	handle func(w http.ResponseWriter, h hit)
}

func (f *fakeForum) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

func (f *fakeForum) paths() []string {
	var out []string
	for _, h := range f.recorded() {
		p := h.Path
		if len(h.Query) > 0 {
			p += "?" + h.Query.Encode()
		}
		out = append(out, p)
	}
	return out
}

func newFake(t *testing.T, handle func(w http.ResponseWriter, h hit)) *fakeForum {
	t.Helper()
	f := &fakeForum{handle: handle}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := hit{
			Method: r.Method, Path: r.URL.Path, Query: r.URL.Query(),
			APIKey: r.Header.Get("Api-Key"), APIUsername: r.Header.Get("Api-Username"),
			ContentType: r.Header.Get("Content-Type"),
		}
		f.mu.Lock()
		f.hits = append(f.hits, h)
		f.mu.Unlock()
		f.handle(w, h)
	}))
	t.Cleanup(srv.Close)
	f.url = srv.URL
	return f
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

var categoriesBody = map[string]any{"category_list": map[string]any{"categories": []any{
	map[string]any{"id": 1, "name": "General", "slug": "general", "description": "<p>Talk</p>", "topic_count": 10, "post_count": 40, "color": "0088CC"},
	map[string]any{"id": 7, "name": "Support Desk", "slug": "support", "description": nil, "topic_count": 3, "post_count": 9, "color": "FF0000", "parent_category_id": 1},
}}}

var topicsBody = map[string]any{"topic_list": map[string]any{"topics": []any{
	map[string]any{"id": 100, "title": "Hello", "slug": "hello", "posts_count": 2, "reply_count": 1, "views": 50, "like_count": 3,
		"category_id": 7, "created_at": "2024-01-01", "last_posted_at": "2024-01-02", "pinned": true, "closed": false, "archived": true,
		"posters": []any{map[string]any{"user_id": 5, "extras": "latest"}}},
	map[string]any{"id": 101, "title": "Orphan", "slug": "orphan", "posts_count": 1, "reply_count": 0, "views": 1, "like_count": 0,
		"category_id": 99, "created_at": "2024-02-01", "last_posted_at": "2024-02-01", "pinned": false, "closed": false, "archived": false},
}}}

var topicBody = map[string]any{
	"id": 100, "title": "Hello", "slug": "hello", "posts_count": 2, "reply_count": 1, "views": 50, "like_count": 3,
	"category_id": 1, "created_at": "2024-01-01", "last_posted_at": "2024-01-02", "pinned": false, "closed": true, "archived": false,
	"post_stream": map[string]any{"posts": []any{
		map[string]any{"id": 1, "username": "alice", "display_username": "Alice A", "created_at": "c1", "updated_at": "u1", "post_number": 1,
			"cooked": "<p>Hi\u00a0 <b>there</b></p>\n<p>bye</p>", "reply_count": 1, "like_count": 2},
		map[string]any{"id": 2, "username": "bob", "display_username": "", "created_at": "c2", "updated_at": "u2", "post_number": 2,
			"raw": "ok", "cooked": "<p>ok</p>", "reply_count": 0, "like_count": 0},
	}},
}

// forumHandler serves the three endpoints the Bun client reads.
func forumHandler(w http.ResponseWriter, h hit) {
	switch {
	case h.Path == "/categories.json":
		writeJSON(w, 200, categoriesBody)
	case h.Path == "/latest.json" || strings.HasSuffix(h.Path, "/l/latest.json"):
		writeJSON(w, 200, topicsBody)
	case h.Path == "/t/100.json":
		writeJSON(w, 200, topicBody)
	case h.Path == "/t/404.json":
		writeJSON(w, 404, map[string]any{"errors": []any{"The requested URL or resource could not be found."}, "error_type": "not_found"})
	default:
		w.WriteHeader(500)
	}
}

func setupVault(t *testing.T) *plugins.Registry {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

func storedCreds(base string) map[string]any {
	return map[string]any{"baseUrl": base, "apiKey": "key-1", "username": "alice", "legacyField": "kept"}
}

func loadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return testbox.Map(c.Credentials.Get("discourse", name))
}

func spec(t *testing.T, path string) *plugins.CommandSpec {
	t.Helper()
	p := New()
	for i := range p.Commands {
		if p.Commands[i].Path == path {
			return &p.Commands[i]
		}
	}
	t.Fatalf("no command %q", path)
	return nil
}

func exec(t *testing.T, reg *plugins.Registry, path string, in plugins.CommandInput) (any, error) {
	t.Helper()
	if in.Options == nil {
		in.Options = map[string]any{}
	}
	if in.Args == nil {
		in.Args = map[string]any{}
	}
	return host.Execute(context.Background(), reg, reg.Find("discourse"), spec(t, path), in)
}

// The command table is the Bun surface. A renamed flag, a lost default, or a
// command that turned into a write fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	type row struct {
		args, flags, access, op, input string
	}
	want := map[string]row{
		"list":       {"", "--category <slug> --page <number>=0", "read", "", ""},
		"get":        {"<topic-id>", "", "read", "", ""},
		"categories": {"", "", "read", "", ""},
	}
	p := New()
	if p.ID != "discourse" || p.DisplayName != "Discourse" || p.Description != "Use when interacting with Discourse forums via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if p.Profile == nil || p.Profile.Refresh != nil {
		t.Fatal("discourse has a static API key: a profile and no refresh lifecycle")
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	if len(p.Commands) != len(want) {
		t.Fatalf("%d commands, want %d", len(p.Commands), len(want))
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
		got := row{strings.Join(args, " "), strings.Join(flags, " "), c.Access, c.Operation, c.Input}
		if got != w {
			t.Errorf("%s:\n got %#v\nwant %#v", c.Path, got, w)
		}
		if len(c.Examples) == 0 || c.Format == nil {
			t.Errorf("%s: missing examples or format", c.Path)
		}
	}
}

func answers(sc *plugins.SetupContext, replies ...string) *[]string {
	var asked []string
	sc.Prompt = func(q string, _ bool) (string, error) {
		asked = append(asked, q)
		if len(replies) == 0 {
			return "", io.EOF
		}
		r := replies[0]
		replies = replies[1:]
		return r, nil
	}
	return &asked
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	fake := newFake(t, forumHandler)
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
	// The URL is given without a scheme change and with a trailing slash; the
	// answers carry whitespace that Bun's prompt() trims as String#trim: the
	// BOM and U+00A0 go, U+0085 stays.
	asked := answers(sc, "  "+fake.url+"/  ", " key-9\u0085 ", "\u00a0carol\xef\xbb\xbf")
	var out bytes.Buffer
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Join(*asked, "|") != "? Forum URL: |? API Key: |? Username: " {
		t.Fatalf("prompts %q", *asked)
	}
	stored := loadCreds(t, "carol")
	var keys []string
	for k := range stored {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "apiKey,baseUrl,username" {
		t.Fatalf("keys %v", keys)
	}
	if stored["baseUrl"] != fake.url || stored["apiKey"] != "key-9\u0085" || stored["username"] != "carol" {
		t.Fatalf("%#v", stored)
	}
	h := fake.recorded()
	if len(h) != 1 || h[0].Path != "/categories.json" || h[0].APIKey != "key-9\u0085" || h[0].APIUsername != "carol" {
		t.Fatalf("validation request %#v", h)
	}
	if !strings.Contains(out.String(), `Profile "carol" configured!`) || !strings.Contains(out.String(), "Test with: agentio discourse list") {
		t.Fatal(out.String())
	}
}

func TestSetupAddsHTTPSWhenTheSchemeIsMissing(t *testing.T) {
	var seen string
	sc := &plugins.SetupContext{
		Log:  func(...any) {},
		Fail: func(code plugins.ErrorCode, m, s string) error { return clierr.New(clierr.Code(code), m, s) },
		Fetch: func(_ context.Context, r *http.Request) (*http.Response, error) {
			seen = r.URL.String()
			return nil, io.ErrUnexpectedEOF
		},
	}
	answers(sc, "forum.example.com/", "k", "u")
	_, err := setup(context.Background(), plugins.SetupOptions{}, sc)
	ce, ok := err.(*clierr.Error)
	if seen != "https://forum.example.com/categories.json" {
		t.Fatalf("url %q", seen)
	}
	if !ok || ce.Code != "NETWORK_ERROR" || ce.Message != "Cannot connect to https://forum.example.com" || ce.Suggestion != "Check the URL and your network connection" {
		t.Fatalf("%#v", err)
	}
}

func TestSetupFailuresMatchBunAndWriteNothing(t *testing.T) {
	setupVault(t)
	status := 401
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		writeJSON(w, status, map[string]any{"errors": []any{"denied", "twice"}})
	})
	cases := []struct {
		replies               []string
		status                int
		code, msg, suggestion string
	}{
		{[]string{""}, 0, "INVALID_PARAMS", "Forum URL is required", ""},
		{nil, 0, "INVALID_PARAMS", "Forum URL is required", ""}, // closed stdin
		{[]string{fake.url, "  "}, 0, "INVALID_PARAMS", "API key is required", ""},
		{[]string{fake.url, "k", ""}, 0, "INVALID_PARAMS", "Username is required", ""},
		{[]string{fake.url, "k", "u"}, 401, "AUTH_FAILED", "Invalid API key or username. Please check your credentials.", "Make sure the API key is active and the username matches"},
		// Any other failure is rethrown as the client raised it.
		{[]string{fake.url, "k", "u"}, 403, "PERMISSION_DENIED", "denied, twice", ""},
	}
	for i, c := range cases {
		status = c.status
		sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard})
		answers(sc, c.replies...)
		err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, io.Discard)
		ce, ok := err.(*clierr.Error)
		if !ok || string(ce.Code) != c.code || ce.Message != c.msg || ce.Suggestion != c.suggestion {
			t.Errorf("case %d: %#v", i, err)
		}
	}
	c, _ := vault.Load()
	if len(c.Credentials.Profiles("discourse")) != 0 {
		t.Fatal("failed setup wrote the vault")
	}
}

// Every Bun leaf is a read, so a read-only profile runs all of them.
func TestReadOnlyProfileRunsEveryCommand(t *testing.T) {
	reg := setupVault(t)
	fake := newFake(t, forumHandler)
	if err := profile.Save("discourse", "ro", testbox.Object(storedCreds(fake.url)), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		path string
		in   plugins.CommandInput
	}{
		{"list", plugins.CommandInput{Options: map[string]any{"page": "0"}}},
		{"get", plugins.CommandInput{Args: map[string]any{"topic-id": "100"}}},
		{"categories", plugins.CommandInput{}},
	} {
		if _, err := exec(t, reg, c.path, c.in); err != nil {
			t.Fatalf("%s: %v", c.path, err)
		}
	}
	if n := len(fake.recorded()); n != 5 {
		t.Fatalf("%d requests, want 5", n)
	}
}

func TestStaticCredentialsReachTheCommandUnchanged(t *testing.T) {
	reg := setupVault(t)
	fake := newFake(t, forumHandler)
	if err := profile.Save("discourse", "meta", testbox.Object(storedCreds(fake.url+"/")), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fresh, err := auth.GetFresh(context.Background(), reg, "discourse", "meta", auth.RefreshOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Credentials.Value("apiKey") != "key-1" || fresh.Credentials.Value("legacyField") != "kept" {
		t.Fatalf("%#v", fresh.Credentials)
	}
	if len(fake.recorded()) != 0 {
		t.Fatal("GetFresh called the forum for a static key")
	}
	if _, err := exec(t, reg, "categories", plugins.CommandInput{}); err != nil {
		t.Fatal(err)
	}
	// The stored trailing slash is stripped, and the Bun headers are sent.
	h := fake.recorded()[0]
	if h.Path != "/categories.json" || h.Method != "GET" || h.APIKey != "key-1" || h.APIUsername != "alice" || h.ContentType != "application/json" {
		t.Fatalf("%#v", h)
	}
	if stored := loadCreds(t, "meta"); stored["baseUrl"] != fake.url+"/" {
		t.Fatalf("vault changed: %#v", stored)
	}
}

func TestValidate(t *testing.T) {
	status := 200
	fake := newFake(t, func(w http.ResponseWriter, h hit) {
		if status == 200 {
			forumHandler(w, h)
			return
		}
		writeJSON(w, status, map[string]any{"errors": []any{"You are not permitted to view the requested resource."}})
	})
	run := host.NewRunContext(testbox.Object(storedCreds(fake.url+"/")), "meta", context.Background())
	res, err := validate(context.Background(), run)
	if err != nil || !res.Valid || res.Info != fake.url {
		t.Fatalf("%#v %v", res, err)
	}
	status = 403
	res, err = validate(context.Background(), run)
	if err != nil || res.Valid || res.Error != "You are not permitted to view the requested resource." {
		t.Fatalf("%#v %v", res, err)
	}
}

// Bun has no secretFields for discourse: the hub serves the whole map.
func TestRemoteRedactionKeepsTheStaticKey(t *testing.T) {
	reg, err := plugins.NewRegistry(New())
	if err != nil {
		t.Fatal(err)
	}
	creds := storedCreds("https://forum.example.com")
	out := auth.RedactForRemote(reg, "discourse", testbox.Object(creds))
	if out.Value("apiKey") != "key-1" || out.Value("username") != "alice" || out.Value("baseUrl") != "https://forum.example.com" || creds["apiKey"] != "key-1" {
		t.Fatalf("%#v", out)
	}
}

func TestCommandsSendTheBunRequests(t *testing.T) {
	reg := setupVault(t)
	fake := newFake(t, forumHandler)
	if err := profile.Save("discourse", "meta", testbox.Object(storedCreds(fake.url)), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		path  string
		in    plugins.CommandInput
		paths []string
	}{
		// Without a category the topics come first, then the category cache.
		{"list", plugins.CommandInput{Options: map[string]any{"page": "0"}}, []string{"/latest.json", "/categories.json"}},
		// parseInt: "2abc" is 2, "x" is NaN (no page), "-1" is not > 0.
		{"list", plugins.CommandInput{Options: map[string]any{"page": "2abc"}}, []string{"/latest.json?page=2", "/categories.json"}},
		{"list", plugins.CommandInput{Options: map[string]any{"page": "x"}}, []string{"/latest.json", "/categories.json"}},
		{"list", plugins.CommandInput{Options: map[string]any{"page": "-1"}}, []string{"/latest.json", "/categories.json"}},
		// A category matches by slug or by case-insensitive name; the cache is then warm.
		{"list", plugins.CommandInput{Options: map[string]any{"category": "support", "page": "1"}}, []string{"/categories.json", "/c/support/7/l/latest.json?page=1"}},
		{"list", plugins.CommandInput{Options: map[string]any{"category": "SUPPORT desk", "page": "0"}}, []string{"/categories.json", "/c/support/7/l/latest.json"}},
		{"get", plugins.CommandInput{Args: map[string]any{"topic-id": " 100abc"}}, []string{"/t/100.json", "/categories.json"}},
	}
	for _, c := range cases {
		before := len(fake.recorded())
		if _, err := exec(t, reg, c.path, c.in); err != nil {
			t.Fatalf("%s %v: %v", c.path, c.in, err)
		}
		got := fake.paths()[before:]
		if strings.Join(got, " ") != strings.Join(c.paths, " ") {
			t.Errorf("%s %v:\n got %v\nwant %v", c.path, c.in, got, c.paths)
		}
	}
}

func TestErrorsMatchBun(t *testing.T) {
	reg := setupVault(t)
	fake := newFake(t, forumHandler)
	if err := profile.Save("discourse", "meta", testbox.Object(storedCreds(fake.url)), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	check := func(label string, err error, code, msg string) {
		t.Helper()
		ce, ok := err.(*clierr.Error)
		if !ok || string(ce.Code) != code || ce.Message != msg || ce.Suggestion != "" {
			t.Errorf("%s: %#v", label, err)
		}
	}
	before := len(fake.recorded())
	_, err := exec(t, reg, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "abc"}})
	check("nan id", err, "INVALID_PARAMS", "Topic ID must be a number")
	if len(fake.recorded()) != before {
		t.Fatal("a non-numeric topic id reached the API")
	}
	_, err = exec(t, reg, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "404"}})
	check("404", err, "NOT_FOUND", "The requested URL or resource could not be found.")
	_, err = exec(t, reg, "list", plugins.CommandInput{Options: map[string]any{"category": "nope", "page": "0"}})
	check("category", err, "NOT_FOUND", `Category "nope" not found`)
	_, err = exec(t, reg, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "5"}})
	check("500", err, "API_ERROR", "Discourse API error: 500")

	_, err = exec(t, reg, "categories", plugins.CommandInput{Options: map[string]any{"profile": "ghost"}})
	if ce, ok := err.(*clierr.Error); !ok || ce.Code != clierr.ProfileNotFound {
		t.Fatalf("%#v", err)
	}
}

func TestErrorMessageFollowsTheBunFallbacks(t *testing.T) {
	cases := []struct{ body, want string }{
		{`{"errors":["a","b"]}`, "a, b"},
		{`{"errors":["a",null,3,true,{}]}`, "a, , 3, true, [object Object]"},
		{`{"errors":[]}`, ""},
		{`{"errors":"flat"}`, `{"errors":"flat"}`},
		{`{"errors":""}`, "Discourse API error: 502"},
		{`{"error_type":"x"}`, "Discourse API error: 502"},
		{`null`, "null"},
		{`[1]`, "Discourse API error: 502"},
		{`"text"`, "Discourse API error: 502"},
		{`Bad Gateway`, "Bad Gateway"},
		{``, "Discourse API error: 502"},
	}
	for _, c := range cases {
		if got := errorMessage(502, c.body); got != c.want {
			t.Errorf("%q: got %q want %q", c.body, got, c.want)
		}
	}
}

// parsed is JSON.parse(raw).
func parsed(t *testing.T, raw string) any {
	t.Helper()
	v, err := jsvalue.Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestFormatMatchesBun(t *testing.T) {
	a := newAPI(context.Background(), testbox.Object(storedCreds("")), nil)
	a.categories[cacheKey(json.Number("7"))] = "Support Desk"
	long := "<b>" + strings.Repeat("é", 99) + "</b>"
	var cats []any
	for _, raw := range []string{
		`{"id":1,"name":"General","slug":"general","description":"<p>Talk</p>","topic_count":10,"post_count":40}`,
		`{"id":7,"name":"Sub","slug":"sub","description":` + jsvalue.Quote(long) + `,"topic_count":0,"post_count":0,"parent_category_id":1}`,
		`{"id":8,"name":"Tags only","slug":"t","description":"<br>","topic_count":0,"post_count":0}`,
	} {
		c, err := parseCategory(parsed(t, raw))
		if err != nil {
			t.Fatal(err)
		}
		cats = append(cats, c)
	}
	want := "Categories (3)\n\n" +
		"[1] General\n    Slug: general\n    Topics: 10 | Posts: 40\n    > Talk\n\n" +
		"[7] Sub (subcategory)\n    Slug: sub\n    Topics: 0 | Posts: 0\n    > " + strings.Repeat("é", 99) + "...\n\n" +
		"[8] Tags only\n    Slug: t\n    Topics: 0 | Posts: 0\n"
	if got := formatCategories(cats); got != want {
		t.Fatalf("categories\n%q\n%q", got, want)
	}
	var topics []any
	for _, raw := range []string{
		`{"id":100,"title":"Hello","posts_count":2,"reply_count":1,"views":50,"like_count":3,"category_id":7,"created_at":"a","last_posted_at":"b","pinned":true,"archived":true}`,
		`{"id":101,"title":"Orphan","posts_count":0,"reply_count":0,"views":0,"like_count":0,"created_at":"a","last_posted_at":"a"}`,
	} {
		tp, err := a.parseTopic(parsed(t, raw))
		if err != nil {
			t.Fatal(err)
		}
		topics = append(topics, tp)
	}
	want = "Topics (2)\n\n" +
		"[1] 100 | Hello [pinned, archived]\n    Category: Support Desk\n    Posts: 2 | Replies: 1 | Views: 50 | Likes: 3\n    Created: a\n    Last Post: b\n\n" +
		"[2] 101 | Orphan\n    Posts: 0 | Replies: 0 | Views: 0 | Likes: 0\n    Created: a\n"
	if got := formatTopics(topics); got != want {
		t.Fatalf("topics\n%q\n%q", got, want)
	}
	if formatTopics([]any{}) != "No topics found" || formatCategories([]any{}) != "No categories found" {
		t.Fatal("empty lists")
	}
	detail := a.topicFields(parsed(t, `{"id":100,"title":"Hello","slug":"hello","posts_count":0,"reply_count":0,"views":0,"like_count":0,"closed":true,"created_at":"a","last_posted_at":"a"}`))
	var posts []any
	for _, raw := range []string{
		`{"username":"alice","display_username":"Alice A","post_number":1,"created_at":"c1","like_count":2,"reply_count":1,"cooked":"<p>Hi\u00a0 <b>there</b></p>\n<p>bye</p>"}`,
		`{"username":"bob","display_username":"","post_number":2,"created_at":"c2","like_count":0,"reply_count":0,"cooked":""}`,
	} {
		p, err := parsePost(parsed(t, raw))
		if err != nil {
			t.Fatal(err)
		}
		posts = append(posts, p)
	}
	detail.Set("posts", posts)
	want = "ID: 100\nTitle: Hello [closed]\nSlug: hello\nPosts: 0 | Replies: 0 | Views: 0 | Likes: 0\nCreated: a\nLast Post: a\n---\n" +
		"\n[Post #1] by Alice A (c1)\nLikes: 2 | Replies: 1\nHi there bye\n" +
		"\n[Post #2] by bob (c2)\nLikes: 0 | Replies: 0\n"
	if got := formatTopic(detail); got != want {
		t.Fatalf("topic\n%q\n%q", got, want)
	}
}

// Fields the forum leaves out or sends as null read as JavaScript reads them:
// "undefined" in the text, a TypeError where Bun dereferences them, and an
// empty 2xx body is null. Expectations are Bun's output against the same
// answers (a local mock through the CLI).
func TestMissingFieldsReadAsBunReadsThem(t *testing.T) {
	reg := setupVault(t)
	type answers struct{ categories, other string }
	cases := []struct {
		name    string
		answer  answers
		path    string
		in      plugins.CommandInput
		out     string
		errText string
	}{
		{"empty categories body", answers{"", "{}"}, "categories", plugins.CommandInput{}, "",
			`null is not an object (evaluating '(await this.request("GET", "/categories.json")).category_list')`},
		{"no category_list", answers{"{}", "{}"}, "categories", plugins.CommandInput{}, "",
			`undefined is not an object (evaluating '(await this.request("GET", "/categories.json")).category_list.categories')`},
		{"no categories", answers{`{"category_list":{}}`, "{}"}, "categories", plugins.CommandInput{}, "",
			`undefined is not an object (evaluating '(await this.request("GET", "/categories.json")).category_list.categories.map')`},
		{"null category", answers{`{"category_list":{"categories":[null]}}`, "{}"}, "categories", plugins.CommandInput{}, "",
			`null is not an object (evaluating 'raw.id')`},
		{"empty category", answers{`{"category_list":{"categories":[{}]}}`, "{}"}, "categories", plugins.CommandInput{},
			"Categories (1)\n\n[undefined] undefined\n    Slug: undefined\n    Topics: undefined | Posts: undefined\n", ""},
		{"no topic_list", answers{`{"category_list":{"categories":[{}]}}`, "{}"}, "list", plugins.CommandInput{Options: map[string]any{"page": "0"}}, "",
			`undefined is not an object (evaluating 'data.topic_list.topics')`},
		{"no topics", answers{`{"category_list":{"categories":[{}]}}`, `{"topic_list":{}}`}, "list", plugins.CommandInput{Options: map[string]any{"page": "0"}}, "",
			`undefined is not an object (evaluating 'data.topic_list.topics.map')`},
		{"empty topic", answers{`{"category_list":{"categories":[{}]}}`, `{"topic_list":{"topics":[{}]}}`}, "list", plugins.CommandInput{Options: map[string]any{"page": "0"}},
			"Topics (1)\n\n[1] undefined | undefined\n    Posts: undefined | Replies: undefined | Views: undefined | Likes: undefined\n    Created: undefined\n", ""},
		{"null poster", answers{`{"category_list":{"categories":[{}]}}`, `{"topic_list":{"topics":[{"last_posted_at":null,"created_at":null,"posters":[null]}]}}`}, "list", plugins.CommandInput{Options: map[string]any{"page": "0"}}, "",
			`null is not an object (evaluating 'p.user_id')`},
		{"nameless category", answers{`{"category_list":{"categories":[{"slug":"x"}]}}`, "{}"}, "list", plugins.CommandInput{Options: map[string]any{"category": "foo", "page": "0"}}, "",
			`undefined is not an object (evaluating 'c.name.toLowerCase')`},
		{"empty topic body", answers{`{"category_list":{"categories":[{}]}}`, ""}, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "1"}}, "",
			`null is not an object (evaluating 'data.id')`},
		{"no post_stream", answers{`{"category_list":{"categories":[{}]}}`, "{}"}, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "1"}}, "",
			`undefined is not an object (evaluating 'data.post_stream.posts')`},
		{"null post", answers{`{"category_list":{"categories":[{}]}}`, `{"post_stream":{"posts":[null]}}`}, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "1"}}, "",
			`null is not an object (evaluating 'raw.id')`},
		{"post without cooked", answers{`{"category_list":{"categories":[{}]}}`, `{"post_stream":{"posts":[{}]}}`}, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "1"}},
			"ID: undefined\nTitle: undefined\nSlug: undefined\nPosts: undefined | Replies: undefined | Views: undefined | Likes: undefined\nCreated: undefined\nLast Post: undefined\n---\n\n[Post #undefined] by undefined (undefined)\nLikes: undefined | Replies: undefined",
			`undefined is not an object (evaluating 'post.cooked.replace')`},
		{"not JSON", answers{"<html>", "{}"}, "categories", plugins.CommandInput{}, "",
			"Failed to connect to Discourse: JSON Parse error: Unrecognized token '<'"},
		// A 204 has no body at all: response.json() throws.
		{"no content", answers{"204", "{}"}, "categories", plugins.CommandInput{}, "",
			"Failed to connect to Discourse: Unexpected end of JSON input"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fake := newFake(t, func(w http.ResponseWriter, h hit) {
				body := c.answer.other
				if h.Path == "/categories.json" {
					body = c.answer.categories
				}
				if body == "204" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, body)
			})
			if err := profile.Save("discourse", "meta", testbox.Object(storedCreds(fake.url)), profile.SaveOptions{}); err != nil {
				t.Fatal(err)
			}
			res, err := exec(t, reg, c.path, c.in)
			out := ""
			if res != nil {
				out = spec(t, c.path).Format(res)
			}
			errText := ""
			if err != nil {
				errText = err.Error()
			}
			if out != c.out || errText != c.errText {
				t.Fatalf("out %q\nerr %q", out, errText)
			}
		})
	}
}

// --json prints the Bun objects: camelCase keys, optional fields omitted.
func TestJSONShapeUsesTheBunFields(t *testing.T) {
	reg := setupVault(t)
	fake := newFake(t, forumHandler)
	if err := profile.Save("discourse", "meta", testbox.Object(storedCreds(fake.url)), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	res, err := exec(t, reg, "list", plugins.CommandInput{Options: map[string]any{"page": "0"}})
	if err != nil {
		t.Fatal(err)
	}
	raw := marshal(res)
	want := `[{"id":100,"title":"Hello","slug":"hello","postsCount":2,"replyCount":1,"views":50,"likeCount":3,"categoryId":7,"categoryName":"Support Desk","createdAt":"2024-01-01","lastPostedAt":"2024-01-02","pinned":true,"closed":false,"archived":true,"posters":[{"userId":5}]},` +
		`{"id":101,"title":"Orphan","slug":"orphan","postsCount":1,"replyCount":0,"views":1,"likeCount":0,"categoryId":99,"createdAt":"2024-02-01","lastPostedAt":"2024-02-01","pinned":false,"closed":false,"archived":false}]`
	if string(raw) != want {
		t.Fatalf("list\n%s\n%s", raw, want)
	}
	res, err = exec(t, reg, "categories", plugins.CommandInput{})
	if err != nil {
		t.Fatal(err)
	}
	raw = marshal(res)
	want = `[{"id":1,"name":"General","slug":"general","description":"<p>Talk</p>","topicCount":10,"postCount":40,"color":"0088CC"},` +
		`{"id":7,"name":"Support Desk","slug":"support","description":"","topicCount":3,"postCount":9,"color":"FF0000","parentCategoryId":1}]`
	if string(raw) != want {
		t.Fatalf("categories\n%s\n%s", raw, want)
	}
	res, err = exec(t, reg, "get", plugins.CommandInput{Args: map[string]any{"topic-id": "100"}})
	if err != nil {
		t.Fatal(err)
	}
	raw = marshal(res)
	if !strings.Contains(string(raw), `"categoryName":"General"`) || strings.Contains(string(raw), "posters") ||
		!strings.Contains(string(raw), `{"id":1,"username":"alice","displayName":"Alice A","createdAt":"c1","updatedAt":"u1","postNumber":1,"cooked":`) ||
		!strings.Contains(string(raw), `"raw":"ok"`) {
		t.Fatalf("get %s", raw)
	}
}

// marshal is JSON.stringify: no HTML escaping.
func marshal(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}
