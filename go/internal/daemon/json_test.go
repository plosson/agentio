package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/board"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
)

// The daemon answers with JSON.stringify: U+2028 and U+2029 unescaped, as
// are <, > and &.
func TestWriteJSONKeepsLineSeparators(t *testing.T) {
	rec := httptest.NewRecorder()
	writeJSON(rec, 200, object{{"error", "a\u2028b\u2029<&>"}, {"list", []string{"\u2028"}}})
	if got, want := rec.Body.String(), "{\"error\":\"a\u2028b\u2029<&>\",\"list\":[\"\u2028\"]}"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// Bun hands a credential object over in the order it was stored, nested
// objects too, and keeps that order when the vault is written again (the
// key's lastUsedAt touch is such a write).
func TestCredentialsKeepTheirStoredKeyOrder(t *testing.T) {
	isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "test-pass-123")
	var c vault.Contents
	stored := `{"zeta":"z","alpha":"a","nested":{"b":1,"a":[{"y":1,"x":2}]},"mid":null}`
	if err := json.Unmarshal([]byte(`{"version":1,"config":{"profiles":{"board":["desk"]}},
		"credentials":{"board":{"desk":`+stored+`}}}`), &c); err != nil {
		t.Fatal(err)
	}
	if err := vault.Create(vault.DefaultVaultPath(), "test-pass-123", &c); err != nil {
		t.Fatal(err)
	}
	issued, err := profile.CreateKey(profile.KeyInput{Name: "agent", AllowedProfiles: "*", ReadOnly: false}, "http://hub.example")
	if err != nil {
		t.Fatal(err)
	}
	reg, err := plugins.NewRegistry(board.New())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer((&Server{Registry: reg, Version: "test"}).Handler())
	defer srv.Close()
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/v1/profiles/board/desk/credentials", nil)
		req.Header.Set("Authorization", "Bearer "+issued.Token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		want := `{"service":"board","name":"desk","readOnly":false,"refreshed":false,"credentials":` + stored + `}`
		if string(body) != want {
			t.Fatalf("call %d:\n got %s\nwant %s", i, body, want)
		}
	}
}

// Bun's /ui/api/status passes readOnly on as stored: an explicit false is
// kept, an absent one omitted.
func TestUIStatusKeepsAnExplicitReadOnlyFalse(t *testing.T) {
	_, client := uiServer(t, nil)
	c := client()
	c.want("POST", "/ui/api/unlock", `{"passphrase":"test-pass-123"}`, 200, `{"ok":true}`)
	err := vault.Update(func(contents *vault.Contents) error {
		var entry vault.ProfileValue
		if err := json.Unmarshal([]byte(`{"name":"cy","readOnly":false}`), &entry); err != nil {
			return err
		}
		contents.Config.Profiles["acme"] = append(contents.Config.Profiles["acme"], entry)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got := c.call("GET", "/ui/api/status?test=false", "")
	if !strings.Contains(got.body, `{"profile":"ada","status":"skipped"}`) || !strings.Contains(got.body, `{"profile":"cy","readOnly":false,"status":"no-creds"}`) {
		t.Fatalf("%d %s", got.status, got.body)
	}
	c.want("GET", "/ui/api/profiles/acme/cy/status", "", 200, `{"profile":"cy","readOnly":false,"status":"no-creds"}`)
}
