package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/acme"
	"github.com/plosson/agentio/go/internal/plugins/ping"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

func isolate(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	ResetLimiters()
	ResetDevice()
	ResetSessions()
	StopKeepalive()
}

func setup(t *testing.T) (*httptest.Server, *plugins.Registry, profile.IssuedKey) {
	t.Helper()
	isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("acme", "ada", map[string]any{
		"account": "ada", "accessToken": "old", "refreshToken": "rt", "expiryDate": int64(1),
	}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(acme.New(), ping.New())
	if err != nil {
		t.Fatal(err)
	}
	issued, err := profile.CreateKey(profile.KeyInput{
		Name: "agent", AllowedProfiles: "*", ReadOnly: false, CanManageProfiles: true,
	}, "http://hub.example")
	if err != nil {
		t.Fatal(err)
	}
	// The token's URL is whatever we minted. The test server is the hub.
	srv := &Server{Registry: reg, Version: "test"}
	httpSrv := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		httpSrv.Close()
		StopKeepalive()
	})
	return httpSrv, reg, issued
}

func TestHealthStaysUpWhileLocked(t *testing.T) {
	isolate(t)
	srv := httptest.NewServer((&Server{Version: "test"}).Handler())
	defer srv.Close()
	res, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	if body["locked"] != true || body["status"] != "ok" {
		t.Fatalf("%#v", body)
	}
	noredirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err = noredirect.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusFound || res.Header.Get("Location") != "/ui" {
		t.Fatalf("root redirect %d %s", res.StatusCode, res.Header.Get("Location"))
	}
}

func TestCredentialsAreRefreshedThenRedacted(t *testing.T) {
	srv, _, issued := setup(t)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/profiles/acme/ada/credentials", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+issued.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	if res.StatusCode != 200 {
		t.Fatalf("%d %#v", res.StatusCode, body)
	}
	creds := body["credentials"].(map[string]any)
	if _, ok := creds["refreshToken"]; ok {
		t.Fatalf("refresh token left the hub: %#v", creds)
	}
	if creds["accessToken"] != "fresh:old" || body["refreshed"] != true {
		t.Fatalf("%#v", body)
	}
	stored, err := auth.GetCredentials("acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	if stored["refreshToken"] != "rot:rt" {
		t.Fatalf("hub did not persist the rotation: %#v", stored)
	}
}

func TestBadTokensAreLimitedAndAMissingPluginIsNotABadToken(t *testing.T) {
	srv, _, issued := setup(t)
	for i := 0; i < 5; i++ {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/profiles", nil)
		req.Header.Set("Authorization", "Bearer nope")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Fatalf("attempt %d = %d", i, res.StatusCode)
		}
	}
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/profiles", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 429 {
		t.Fatalf("sixth bad token = %d", res.StatusCode)
	}
	if err := profile.Save("ping", "any", map[string]any{"x": "1"}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/v1/profiles/ping/any/credentials", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+issued.Token)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 404 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("credential-less plugin = %d %s", res.StatusCode, b)
	}
}

func TestManageGateAndDeviceApproval(t *testing.T) {
	srv, _, issued := setup(t)
	// A key that cannot manage is refused before any write.
	narrow, err := profile.CreateKey(profile.KeyInput{
		Name: "reader", AllowedProfiles: "*", ReadOnly: true, CanManageProfiles: false,
	}, "http://hub.example")
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodPut, srv.URL+"/v1/profiles/acme/bea", strings.NewReader(`{"credentials":{"a":1}}`))
	req.Header.Set("Authorization", "Bearer "+narrow.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("unmanaged put = %d", res.StatusCode)
	}
	req, _ = http.NewRequest(http.MethodPut, srv.URL+"/v1/profiles/acme/bea", strings.NewReader(`{"credentials":{}}`))
	req.Header.Set("Authorization", "Bearer "+issued.Token)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 400 {
		t.Fatalf("empty credentials = %d", res.StatusCode)
	}
	req, _ = http.NewRequest(http.MethodPut, srv.URL+"/v1/profiles/acme/bea", strings.NewReader(`{"credentials":{"accessToken":"x","refreshToken":"y","account":"bea"}}`))
	req.Header.Set("Authorization", "Bearer "+issued.Token)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatalf("create = %d", res.StatusCode)
	}
	// Reader is read-only, so the effective flag is true even though the profile is not.
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/v1/profiles/acme/ada/credentials", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer "+narrow.Token)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	res.Body.Close()
	if body["readOnly"] != true {
		t.Fatalf("read-only key was handed a writable view: %#v", body)
	}

	started, err := StartDevice("laptop", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	poll, err := PollDevice(started.DeviceCode, time.Now())
	if err != nil || poll.Status != "pending" {
		t.Fatalf("%+v %v", poll, err)
	}
	// The owner approves through the UI, which needs a session.
	unlock := httptest.NewRequest(http.MethodPost, srv.URL+"/ui/api/unlock", strings.NewReader(`{"passphrase":"nope"}`))
	_ = unlock
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := srv.Client()
	client.Jar = jar
	res, err = client.Post(srv.URL+"/ui/api/unlock", "application/json", strings.NewReader(`{"passphrase":"wrong-pass"}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode == 200 {
		t.Fatal("wrong passphrase unlocked")
	}
	res, err = client.Post(srv.URL+"/ui/api/unlock", "application/json", strings.NewReader(`{"passphrase":"test-pass-123"}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("unlock %d", res.StatusCode)
	}
	approveBody := `{"approve":true,"name":"laptop","url":"http://127.0.0.1:7890","allowedProfiles":"*","readOnly":false,"canManageProfiles":false}`
	res, err = client.Post(srv.URL+"/ui/api/authorize/"+started.UserCode, "application/json", strings.NewReader(approveBody))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 201 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("approve %d %s", res.StatusCode, b)
	}
	res.Body.Close()
	poll, err = PollDevice(started.DeviceCode, time.Now())
	if err != nil || poll.Status != "approved" || poll.Token == "" {
		t.Fatalf("%+v %v", poll, err)
	}
	if _, err := PollDevice(started.DeviceCode, time.Now()); err == nil {
		t.Fatal("approved device code was reusable")
	}
	page, err := client.Get(srv.URL + "/ui")
	if err != nil {
		t.Fatal(err)
	}
	defer page.Body.Close()
	html, _ := io.ReadAll(page.Body)
	if !strings.Contains(page.Header.Get("Content-Security-Policy"), "nonce-") {
		t.Fatal("admin page has no CSP nonce")
	}
	if !bytes.Contains(html, []byte("script nonce=")) && !bytes.Contains(html, []byte("<script nonce=")) {
		t.Fatal("admin page script is not nonced")
	}
}

func TestRemoteClientReceivesRedactedCredentials(t *testing.T) {
	srv, _, _ := setup(t)
	issued, err := profile.CreateKey(profile.KeyInput{
		Name: "remote", AllowedProfiles: "*", ReadOnly: false, CanManageProfiles: false,
	}, srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENTIO_TOKEN", issued.Token)
	auth.Reset()
	creds, err := auth.RemoteCredentials("acme", "ada")
	if err != nil {
		t.Fatal(err)
	}
	if creds["accessToken"] != "fresh:old" {
		t.Fatalf("remote client got %#v", creds)
	}
	if _, ok := creds["refreshToken"]; ok {
		t.Fatal("remote client received the refresh token")
	}
	t.Setenv("AGENTIO_TOKEN", "")
	auth.Reset()
	if err := profile.Save("acme", "bare", map[string]any{"account": "bare"}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AGENTIO_TOKEN", issued.Token)
	auth.Reset()
	if err := vault.Update(func(c *vault.Contents) error {
		delete(c.Credentials["acme"], "bare")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got, err := auth.RemoteCredentials("acme", "bare")
	if err != nil || got != nil {
		t.Fatalf("missing credentials = %#v %v", got, err)
	}
}

func TestKeepaliveSkipsEmptyAndRefreshesStale(t *testing.T) {
	isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("acme", "empty", map[string]any{}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	// empty map is stored, so it is not skipped. A profile entry with no
	// credential key is skipped. Delete the credential key only.
	if err := vault.Update(func(c *vault.Contents) error {
		delete(c.Credentials["acme"], "empty")
		c.Config.Profiles["acme"] = append(c.Config.Profiles["acme"], vault.ProfileValue{Name: "stale"})
		c.Credentials["acme"]["stale"] = map[string]any{
			"account": "ada", "accessToken": "old", "refreshToken": "rt", "expiryDate": int64(1),
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(acme.New())
	if err != nil {
		t.Fatal(err)
	}
	result := RunRefreshPass(context.Background(), reg, []string{"acme"})
	if result.Skipped != 1 || result.Refreshed != 1 || result.Failed != 0 {
		t.Fatalf("%+v", result)
	}
	if hours := IntervalHours("0"); hours != 0 {
		t.Fatal(hours)
	}
	if hours := IntervalHours("nope"); hours != DefaultIntervalHours {
		t.Fatal(hours)
	}
	if hours := IntervalHours("9999"); hours != MaxIntervalHours {
		t.Fatal(hours)
	}
}

func TestTrustedIPHeaderUsesTheLastHop(t *testing.T) {
	t.Setenv("AGENTIO_TRUSTED_IP_HEADER", "X-Forwarded-For")
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-For", "1.1.1.1, 2.2.2.2")
	req.RemoteAddr = "9.9.9.9:1"
	if got := ClientIP(req); got != "2.2.2.2" {
		t.Fatal(got)
	}
	t.Setenv("AGENTIO_TRUSTED_IP_HEADER", "")
	if got := ClientIP(req); got != "9.9.9.9" {
		t.Fatal(got)
	}
}
