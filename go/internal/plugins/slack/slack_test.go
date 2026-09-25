package slack

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// hit is one request that reached the fake webhook.
type hit struct {
	Method      string
	Path        string
	ContentType string
	Body        string
}

type fakeHook struct {
	mu     sync.Mutex
	hits   []hit
	url    string // http://127.0.0.1:port
	status int
	reply  string
}

func (f *fakeHook) recorded() []hit {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]hit(nil), f.hits...)
}

func newFake(t *testing.T) *fakeHook {
	t.Helper()
	f := &fakeHook{status: 200, reply: "ok"}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.hits = append(f.hits, hit{Method: r.Method, Path: r.URL.Path, ContentType: r.Header.Get("Content-Type"), Body: string(body)})
		status, reply := f.status, f.reply
		f.mu.Unlock()
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(srv.Close)
	f.url = srv.URL
	return f
}

// fetch sends every request to the fake, whatever host and scheme it named:
// a stored webhook is https://hooks.slack.com/..., as setup requires.
func (f *fakeHook) fetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	target, _ := url.Parse(f.url)
	req = req.Clone(ctx)
	req.URL.Scheme, req.URL.Host, req.Host = target.Scheme, target.Host, ""
	return http.DefaultClient.Do(req)
}

const hookURL = "https://hooks.slack.com/services/T000/B000/fakesecret"

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

func storedCreds() map[string]any {
	return map[string]any{"type": "webhook", "webhookUrl": hookURL, "channelName": "alerts"}
}

func loadCreds(t *testing.T, name string) map[string]any {
	t.Helper()
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	return testbox.Map(c.Credentials.Get("slack", name))
}

func keys(m map[string]any) string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// runSend runs `slack send` with a RunContext whose fetch goes to the fake.
func runSend(t *testing.T, f *fakeHook, creds plugins.Credentials, in plugins.CommandInput) (any, error) {
	t.Helper()
	if in.Args == nil {
		in.Args = map[string]any{}
	}
	if in.Options == nil {
		in.Options = map[string]any{}
	}
	run := host.NewRunContext(creds, "alerts", context.Background())
	run.Fetch = f.fetch
	spec := sendCmd()
	return host.Invoke(context.Background(), &spec, in, run)
}

func cliErr(t *testing.T, err error) *clierr.Error {
	t.Helper()
	var ce *clierr.Error
	if !errors.As(err, &ce) {
		t.Fatalf("not a CLI error: %#v", err)
	}
	return ce
}

// The command table is the Bun surface. A renamed flag, a lost operation, a
// send that turned into a read, or a lifecycle Bun does not have fails here.
func TestCommandTableMatchesBun(t *testing.T) {
	p := New()
	if p.ID != "slack" || p.DisplayName != "Slack" || p.Description != "Use when sending Slack messages via the agentio CLI." {
		t.Fatalf("identity %q %q %q", p.ID, p.DisplayName, p.Description)
	}
	if p.Profile == nil || p.Profile.Refresh != nil || p.Profile.Reauthenticate != nil {
		t.Fatal("slack has a static webhook: a profile, no refresh, no reauthentication")
	}
	if !p.Profile.RequireProfile || len(p.Profile.SetupOptions) != 0 {
		t.Fatal("Bun `slack profile add` requires --profile and has no other flag")
	}
	if _, err := plugins.NewRegistry(p); err != nil {
		t.Fatal(err)
	}
	if len(p.Commands) != 1 {
		t.Fatalf("%d commands, want 1", len(p.Commands))
	}
	c := p.Commands[0]
	if c.Path != "send" || c.Description != "Send a message to Slack" || c.Operation != "send message" || c.Input != "text" || c.Access != "write" {
		t.Fatalf("%#v", c)
	}
	if len(c.Arguments) != 1 || c.Arguments[0].Name != "message" || c.Arguments[0].Required || c.Arguments[0].Variadic {
		t.Fatalf("arguments %#v", c.Arguments)
	}
	if len(c.Options) != 1 || c.Options[0].Flags != "--json [file]" || c.Options[0].DefaultValue != nil {
		t.Fatalf("options %#v", c.Options)
	}
	if c.Prepare == nil || c.AccessFor != nil {
		t.Fatal("send must read its input before the profile, and always be a write")
	}
	if len(c.Examples) == 0 || c.Format == nil {
		t.Fatal("missing examples or format")
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

func newSetupContext(f *fakeHook, logs *bytes.Buffer) *plugins.SetupContext {
	sc := host.NewSetupContext(host.Streams{In: strings.NewReader(""), Out: io.Discard, Err: logs})
	sc.Fetch = f.fetch
	return sc
}

func TestSetupUsesBunKeysAndTheHostSavesIt(t *testing.T) {
	setupVault(t)
	fake := newFake(t)
	var logs bytes.Buffer
	sc := newSetupContext(fake, &logs)
	// Bun prompt() trims both answers.
	asked := answers(sc, "  "+hookURL+"  ", " alerts ")
	var out bytes.Buffer
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Join(*asked, "|") != "? Paste your webhook URL: |? Channel name (optional, for display): " {
		t.Fatalf("prompts %q", *asked)
	}
	wantLogs := "\nSlack Webhook Setup\n\n" +
		"1. Go to https://api.slack.com/apps and create a new app (or use existing)\n" +
		"2. Enable \"Incoming Webhooks\" in Features\n" +
		"3. Click \"Add New Webhook to Workspace\" and select a channel\n" +
		"4. Copy the Webhook URL\n\n"
	if logs.String() != wantLogs {
		t.Fatalf("logs %q", logs.String())
	}
	stored := loadCreds(t, "alerts")
	if keys(stored) != "channelName,type,webhookUrl" || stored["type"] != "webhook" || stored["webhookUrl"] != hookURL || stored["channelName"] != "alerts" {
		t.Fatalf("%#v", stored)
	}
	h := fake.recorded()
	if len(h) != 1 || h[0].Method != "POST" || h[0].Path != "/services/T000/B000/fakesecret" ||
		h[0].ContentType != "application/json" || h[0].Body != `{"text":"Test message from agentio"}` {
		t.Fatalf("test message %#v", h)
	}
	if out.String() != "Profile \"alerts\" configured!\nTest with: agentio slack send \"Hello from agentio\"\n" {
		t.Fatalf("%q", out.String())
	}
}

// No channel name: the key is left out (Bun `channelName || undefined`) and
// the profile is named "webhook" unless --profile names it.
func TestSetupWithoutAChannelName(t *testing.T) {
	setupVault(t)
	fake := newFake(t)
	sc := newSetupContext(fake, &bytes.Buffer{})
	answers(sc, hookURL, "   ")
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{}, sc, io.Discard); err != nil {
		t.Fatal(err)
	}
	if stored := loadCreds(t, "webhook"); keys(stored) != "type,webhookUrl" {
		t.Fatalf("%#v", stored)
	}
	sc = newSetupContext(fake, &bytes.Buffer{})
	answers(sc, hookURL) // closed stdin at the second prompt is no answer
	if err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{Profile: "ops", ReadOnly: true}, sc, io.Discard); err != nil {
		t.Fatal(err)
	}
	if stored := loadCreds(t, "ops"); keys(stored) != "type,webhookUrl" {
		t.Fatalf("%#v", stored)
	}
	if ro, _ := profile.IsReadOnly("slack", "ops"); !ro {
		t.Fatal("--read-only was not kept")
	}
}

func TestSetupFailuresMatchBunAndWriteNothing(t *testing.T) {
	setupVault(t)
	fake := newFake(t)
	cases := []struct {
		name                  string
		replies               []string
		status                int
		reply                 string
		code, msg, suggestion string
		posts                 int
	}{
		{"empty", []string{"   "}, 200, "", "INVALID_PARAMS", "Webhook URL is required", "", 0},
		{"closed stdin", nil, 200, "", "INVALID_PARAMS", "Webhook URL is required", "", 0},
		{"not a slack hook", []string{"https://example.com/hook"}, 200, "", "INVALID_PARAMS", "Invalid Slack webhook URL", "URL should start with https://hooks.slack.com/", 0},
		{"http slack hook", []string{"http://hooks.slack.com/services/x"}, 200, "", "INVALID_PARAMS", "Invalid Slack webhook URL", "URL should start with https://hooks.slack.com/", 0},
		// Only a 2xx passes; the body is Bun's response.text().
		{"rejected", []string{hookURL}, 403, "invalid_token", "API_ERROR", "Webhook validation failed: 403 invalid_token", "Check the webhook URL and try again", 1},
		{"not found", []string{hookURL}, 404, "no_service", "API_ERROR", "Webhook validation failed: 404 no_service", "Check the webhook URL and try again", 1},
		{"redirect status", []string{hookURL}, 304, "", "API_ERROR", "Webhook validation failed: 304 ", "Check the webhook URL and try again", 1},
	}
	for _, c := range cases {
		fake.mu.Lock()
		fake.hits, fake.status, fake.reply = nil, c.status, c.reply
		fake.mu.Unlock()
		sc := newSetupContext(fake, &bytes.Buffer{})
		asked := answers(sc, c.replies...)
		err := host.AddProfile(context.Background(), New(), plugins.SetupOptions{Profile: "p"}, sc, io.Discard)
		ce := cliErr(t, err)
		if string(ce.Code) != c.code || ce.Message != c.msg || ce.Suggestion != c.suggestion {
			t.Errorf("%s: %#v", c.name, ce)
		}
		if n := len(fake.recorded()); n != c.posts {
			t.Errorf("%s: %d posts, want %d", c.name, n, c.posts)
		}
		if len(*asked) != 1 {
			t.Errorf("%s: the channel was asked after a failure: %q", c.name, *asked)
		}
	}
	c, _ := vault.Load()
	if len(c.Credentials.Profiles("slack")) != 0 || len(c.Config.Profiles.Get("slack")) != 0 {
		t.Fatal("failed setup wrote the vault")
	}
}

func TestSetupNetworkFailureIsAnAPIError(t *testing.T) {
	sc := &plugins.SetupContext{
		Log:  func(...any) {},
		Fail: func(code plugins.ErrorCode, m, s string) error { return clierr.New(clierr.Code(code), m, s) },
		Fetch: func(context.Context, *http.Request) (*http.Response, error) {
			return nil, errors.New("connection refused")
		},
	}
	answers(sc, hookURL, "alerts")
	res, err := setup(context.Background(), plugins.SetupOptions{}, sc)
	ce := cliErr(t, err)
	if res != nil || ce.Code != "API_ERROR" || ce.Message != "Failed to validate webhook: connection refused" || ce.Suggestion != "Check that the URL is correct and accessible" {
		t.Fatalf("%#v %#v", res, ce)
	}
}

// Bun has no credential lifecycle for slack: GetFresh returns the stored map
// without a request, and the hub serves the whole map (no secretFields).
func TestStaticWebhookIsNeverRefreshedOrRedacted(t *testing.T) {
	reg := setupVault(t)
	creds := storedCreds()
	creds["legacyField"] = "kept"
	if err := profile.Save("slack", "alerts", testbox.Object(creds), profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	fresh, err := auth.GetFresh(context.Background(), reg, "slack", "alerts", auth.RefreshOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Credentials.Value("webhookUrl") != hookURL || fresh.Credentials.Value("legacyField") != "kept" {
		t.Fatalf("%#v", fresh.Credentials)
	}
	if stored := loadCreds(t, "alerts"); keys(stored) != "channelName,legacyField,type,webhookUrl" {
		t.Fatalf("vault changed: %#v", stored)
	}
	out := auth.RedactForRemote(reg, "slack", testbox.Object(creds))
	if out.Value("webhookUrl") != hookURL || out.Value("channelName") != "alerts" || out.Value("type") != "webhook" || creds["webhookUrl"] != hookURL {
		t.Fatalf("%#v", out)
	}
}

// Bun remote-mode: a read-only slack profile refuses send before any network
// call. Input Bun rejects before enforceWriteAccess is still reported as such.
func TestReadOnlyProfileRefusesSend(t *testing.T) {
	reg := setupVault(t)
	fake := newFake(t)
	// A stored URL at the fake: a send that got through would reach it.
	creds := map[string]any{"type": "webhook", "webhookUrl": strings.Replace(fake.url, "http://", "https://", 1) + "/hook"}
	if err := profile.Save("slack", "ops", testbox.Object(creds), profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	p := reg.Find("slack")
	exec := func(in plugins.CommandInput) (any, error) {
		if in.Args == nil {
			in.Args = map[string]any{}
		}
		if in.Options == nil {
			in.Options = map[string]any{}
		}
		return host.Execute(context.Background(), reg, p, &p.Commands[0], in)
	}
	res, err := exec(plugins.CommandInput{Args: map[string]any{"message": "hello"}})
	ce := cliErr(t, err)
	if res != nil || ce.Code != clierr.PermissionDenied || ce.Message != `Cannot send message: profile "ops" is read-only` ||
		ce.Suggestion != "To modify this profile's access: agentio slack profile update --profile ops --no-read-only" {
		t.Fatalf("%#v %#v", res, ce)
	}
	res, err = exec(plugins.CommandInput{Stdin: "  \n"})
	ce = cliErr(t, err)
	if res != nil || ce.Code != clierr.InvalidParams || ce.Message != "Message is required. Provide as argument or pipe via stdin." {
		t.Fatalf("%#v %#v", res, ce)
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("%d requests reached the webhook", n)
	}
	// What a read-only profile may still do: validate, and be listed.
	run := host.NewRunContext(testbox.Object(loadCreds(t, "ops")), "ops", context.Background())
	if v, err := validate(context.Background(), run); err != nil || !v.Valid || v.Info != "webhook" {
		t.Fatalf("%#v %v", v, err)
	}
}

func TestValidateAndListInfo(t *testing.T) {
	for _, c := range []struct {
		creds      map[string]any
		info, list string
	}{
		{storedCreds(), "#alerts", " - #alerts"},
		{map[string]any{"type": "webhook", "webhookUrl": hookURL}, "webhook", " - webhook"},
		{map[string]any{"channelName": ""}, "webhook", " - webhook"},
		{map[string]any{}, "webhook", " - webhook"},
	} {
		run := host.NewRunContext(testbox.Object(c.creds), "p", context.Background())
		v, err := validate(context.Background(), run)
		if err != nil || !v.Valid || v.Info != c.info || v.Error != "" {
			t.Errorf("%#v: %#v %v", c.creds, v, err)
		}
		if got := listInfo(testbox.Object(c.creds)); got != c.list {
			t.Errorf("%#v: list %q", c.creds, got)
		}
	}
}

func TestSendPostsTheBunBody(t *testing.T) {
	dir := t.TempDir()
	blocks := filepath.Join(dir, "alert.json")
	// Key order and number text survive, and <, > and & are not escaped, as
	// JSON.parse then JSON.stringify leaves them.
	if err := os.WriteFile(blocks, []byte(` {"z":1.50,"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"<b>&</b>"}}],"a":1e3} `), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		in     plugins.CommandInput
		body   string
		format string
	}{
		{"argument", plugins.CommandInput{Args: map[string]any{"message": "deploy <done> & ok"}}, `{"text":"deploy <done> & ok"}`, "Message sent"},
		{"stdin trimmed", plugins.CommandInput{Stdin: "\n  build failed  \n"}, `{"text":"build failed"}`, "Message sent"},
		{"argument wins over stdin", plugins.CommandInput{Args: map[string]any{"message": "arg"}, Stdin: "piped"}, `{"text":"arg"}`, "Message sent"},
		{"json file", plugins.CommandInput{Options: map[string]any{"json": blocks}},
			`{"z":1.5,"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"<b>&</b>"}}],"a":1000}`, "Message sent\nType: Block Kit payload"},
		{"json stdin", plugins.CommandInput{Options: map[string]any{"json": true}, Stdin: ` {"text":"hi","b":[]} `}, `{"text":"hi","b":[]}`, "Message sent\nType: Block Kit payload"},
		{"empty argument with --json", plugins.CommandInput{Args: map[string]any{"message": ""}, Options: map[string]any{"json": true}, Stdin: `[1]`}, `[1]`, "Message sent\nType: Block Kit payload"},
		// `payload ?? { text }` and `!!payload`: null falls back to {} and a
		// falsy payload is sent but not called Block Kit.
		{"null payload", plugins.CommandInput{Options: map[string]any{"json": true}, Stdin: "null"}, `{}`, "Message sent"},
		{"zero payload", plugins.CommandInput{Options: map[string]any{"json": true}, Stdin: "0"}, `0`, "Message sent"},
		{"empty string payload", plugins.CommandInput{Options: map[string]any{"json": true}, Stdin: `""`}, `""`, "Message sent"},
	}
	for _, c := range cases {
		fake := newFake(t)
		res, err := runSend(t, fake, testbox.Object(storedCreds()), c.in)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		h := fake.recorded()
		if len(h) != 1 || h[0].Method != "POST" || h[0].Path != "/services/T000/B000/fakesecret" || h[0].ContentType != "application/json" || h[0].Body != c.body {
			t.Errorf("%s: %#v", c.name, h)
		}
		if got := formatSendResult(res); got != c.format {
			t.Errorf("%s: format %q", c.name, got)
		}
		r := res.(*sendResult)
		if !r.Success || r.IsJSONPayload != strings.Contains(c.format, "Block Kit") {
			t.Errorf("%s: %#v", c.name, r)
		}
	}
}

// The result carries Bun SlackSendResult's fields, both always present.
func TestSendResultJSONUsesTheBunFields(t *testing.T) {
	var b bytes.Buffer
	if err := host.PrintResult(&b, &plugins.CommandSpec{}, &sendResult{Success: true}, true); err != nil {
		t.Fatal(err)
	}
	if b.String() != "{\n  \"success\": true,\n  \"isJsonPayload\": false\n}\n" {
		t.Fatalf("%q", b.String())
	}
}

func TestSendInputErrorsMatchBun(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte("{bad"), 0o600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "missing.json")
	cases := []struct {
		name                  string
		in                    plugins.CommandInput
		code, msg, suggestion string
	}{
		{"nothing", plugins.CommandInput{}, "INVALID_PARAMS", "Message is required. Provide as argument or pipe via stdin.", ""},
		{"blank stdin", plugins.CommandInput{Stdin: " \n\t"}, "INVALID_PARAMS", "Message is required. Provide as argument or pipe via stdin.", ""},
		{"text and --json", plugins.CommandInput{Args: map[string]any{"message": "hi"}, Options: map[string]any{"json": "x.json"}},
			"INVALID_PARAMS", "Cannot use both text message and --json option", `Use either: agentio slack send "text" OR agentio slack send --json file.json`},
		{"text and bare --json", plugins.CommandInput{Args: map[string]any{"message": "hi"}, Options: map[string]any{"json": true}, Stdin: "{}"},
			"INVALID_PARAMS", "Cannot use both text message and --json option", `Use either: agentio slack send "text" OR agentio slack send --json file.json`},
		{"missing file", plugins.CommandInput{Options: map[string]any{"json": missing}},
			"INVALID_PARAMS", "Failed to read JSON file: " + missing, "Check that the file exists and is readable"},
		{"directory", plugins.CommandInput{Options: map[string]any{"json": dir}},
			"INVALID_PARAMS", "Failed to read JSON file: " + dir, "Check that the file exists and is readable"},
		{"empty file name", plugins.CommandInput{Options: map[string]any{"json": ""}},
			"INVALID_PARAMS", "Failed to read JSON file: ", "Check that the file exists and is readable"},
		{"no stdin", plugins.CommandInput{Options: map[string]any{"json": true}},
			"INVALID_PARAMS", "No JSON provided via stdin", "Pipe JSON content: cat message.json | agentio slack send --json"},
		{"bad file", plugins.CommandInput{Options: map[string]any{"json": bad}},
			"INVALID_PARAMS", "Invalid JSON: JSON Parse error: Expected '}'", "Check that the JSON is valid"},
		{"bad stdin", plugins.CommandInput{Options: map[string]any{"json": true}, Stdin: "nope"},
			"INVALID_PARAMS", `Invalid JSON: JSON Parse error: Unexpected identifier "nope"`, "Check that the JSON is valid"},
		{"trailing text", plugins.CommandInput{Options: map[string]any{"json": true}, Stdin: `{"a":1}x`},
			"INVALID_PARAMS", "Invalid JSON: JSON Parse error: Unable to parse JSON string", "Check that the JSON is valid"},
	}
	fake := newFake(t)
	spec := sendCmd()
	for _, c := range cases {
		res, err := runSend(t, fake, testbox.Object(storedCreds()), c.in)
		ce := cliErr(t, err)
		if res != nil || string(ce.Code) != c.code || ce.Message != c.msg || ce.Suggestion != c.suggestion {
			t.Errorf("%s: %#v %#v", c.name, res, ce)
		}
		// Bun rejects these before getSlackClient: Prepare alone refuses them.
		in := c.in
		if in.Args == nil {
			in.Args = map[string]any{}
		}
		if in.Options == nil {
			in.Options = map[string]any{}
		}
		pre := &plugins.PrepareContext{Log: func(...any) {}, Fail: host.NewRunContext(nil, "", nil).Fail}
		if _, done, err := spec.Prepare(context.Background(), in, pre); done || cliErr(t, err).Message != c.msg {
			t.Errorf("%s: prepare %v %v", c.name, done, err)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("%d requests for rejected input", n)
	}
}

func TestSendCredentialAndWebhookErrorsMatchBun(t *testing.T) {
	fake := newFake(t)
	text := plugins.CommandInput{Args: map[string]any{"message": "hi"}}
	for _, c := range []struct {
		name                  string
		creds                 map[string]any
		code, msg, suggestion string
	}{
		{"no type", map[string]any{"webhookUrl": hookURL}, "INVALID_PARAMS", "Unknown credentials type", ""},
		{"bot token", map[string]any{"type": "bot", "token": "xoxb-fake"}, "INVALID_PARAMS", "Unknown credentials type", ""},
		{"no url", map[string]any{"type": "webhook"}, "INVALID_PARAMS", "Invalid webhook URL - must be HTTPS", "Check the webhook URL configuration"},
		{"blank url", map[string]any{"type": "webhook", "webhookUrl": "  "}, "INVALID_PARAMS", "Invalid webhook URL - must be HTTPS", "Check the webhook URL configuration"},
		{"http url", map[string]any{"type": "webhook", "webhookUrl": "http://hooks.slack.com/x"}, "INVALID_PARAMS", "Invalid webhook URL - must be HTTPS", "Check the webhook URL configuration"},
		{"padded url", map[string]any{"type": "webhook", "webhookUrl": " https://hooks.slack.com/x"}, "INVALID_PARAMS", "Invalid webhook URL - must be HTTPS", "Check the webhook URL configuration"},
	} {
		res, err := runSend(t, fake, testbox.Object(c.creds), text)
		ce := cliErr(t, err)
		if res != nil || string(ce.Code) != c.code || ce.Message != c.msg || ce.Suggestion != c.suggestion {
			t.Errorf("%s: %#v", c.name, ce)
		}
	}
	if n := len(fake.recorded()); n != 0 {
		t.Fatalf("%d requests with unusable credentials", n)
	}
	// A failed status maps through httpStatusToErrorCode, with the body text.
	for _, c := range []struct {
		status int
		reply  string
		code   string
	}{
		{400, "invalid_payload", "API_ERROR"},
		{403, "invalid_token", "PERMISSION_DENIED"},
		{404, "no_service", "NOT_FOUND"},
		{410, "channel_is_archived", "API_ERROR"},
		{429, "rate_limited", "RATE_LIMITED"},
		{500, "", "API_ERROR"},
	} {
		fake.mu.Lock()
		fake.status, fake.reply = c.status, c.reply
		fake.mu.Unlock()
		res, err := runSend(t, fake, testbox.Object(storedCreds()), text)
		ce := cliErr(t, err)
		want := "Failed to send message via webhook: " + strconv.Itoa(c.status) + " " + c.reply
		if res != nil || string(ce.Code) != c.code || ce.Message != want || ce.Suggestion != "Check that the webhook URL is valid and the app has permission to post" {
			t.Errorf("%d: %#v", c.status, ce)
		}
	}
	// A request that never got an answer is NETWORK_ERROR.
	run := host.NewRunContext(testbox.Object(storedCreds()), "alerts", context.Background())
	run.Fetch = func(context.Context, *http.Request) (*http.Response, error) {
		return nil, errors.New("dial tcp: connection refused")
	}
	spec := sendCmd()
	res, err := host.Invoke(context.Background(), &spec, text, run)
	ce := cliErr(t, err)
	if res != nil || ce.Code != "NETWORK_ERROR" || ce.Message != "Webhook request failed: dial tcp: connection refused" || ce.Suggestion != "Verify the webhook URL is correct and accessible" {
		t.Fatalf("%#v", ce)
	}
}
