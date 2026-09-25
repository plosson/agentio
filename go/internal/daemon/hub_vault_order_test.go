package daemon

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/vault"
)

// What an agent writes through the hub lands in the vault as the Bun hub
// writes it: the credential object in the order the agent sent it, a replaced
// profile in its place, a renamed one moved last, the key's scope grown, and
// lastUsedAt after the key's other members. Both daemons serve one seed; the
// decrypted vaults are compared after every request.
func TestHubWritesMatchBunVault(t *testing.T) {
	if testing.Short() {
		t.Skip("starts the Bun daemon")
	}
	isolate(t)
	const secret = "hub-order-secret"
	sum := sha256.Sum256([]byte(secret))
	seed := `{"credentials":{"github":{"work":{"username":"octo","zNested":{"b":1,"a":[2,1]},"accessToken":"gho_x&y"}},"gmail":{"bare":{"z":1,"a":2}}},` +
		`"version":1,"config":{"server":{"z":1},"profiles":{"github":[{"note":"n","name":"work"}],"gmail":["bare"]},` +
		`"apiKeys":[{"name":"agent","id":"k1","secretHash":"` + hex.EncodeToString(sum[:]) + `","allowedProfiles":["github/work","gmail/bare"],"readOnly":false,"createdAt":"2026-01-01T00:00:00.000Z","canManageProfiles":true,"future":{"b":1,"a":2}}]},"zz":1}`
	token, err := auth.EncodeToken(auth.TokenParts{URL: "http://127.0.0.1", Kid: "k1", Secret: secret})
	if err != nil {
		t.Fatal(err)
	}
	seedAt := func(home string) string {
		dir := filepath.Join(home, ".config", "agentio")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(dir, "vault.enc")
		enc, err := vault.Encrypt(seed, parityPass)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(enc), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "vault.path"), []byte(path+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	bunHome := t.TempDir()
	bunVault := seedAt(bunHome)
	goVault := seedAt(os.Getenv("HOME"))
	t.Setenv("AGENTIO_PASSPHRASE", "")
	vault.Reset()
	vault.SetMemoryOnly(true)
	t.Cleanup(vault.Reset)
	t.Setenv("AGENTIO_TRUSTED_IP_HEADER", "X-Test-Ip")

	bunBase := startBunDaemon(t, bunHome)
	srv := httptest.NewServer((&Server{Registry: parityRegistry(t), Version: "parity"}).Handler())
	defer srv.Close()

	send := func(base, method, path, body string, bearer bool) int {
		t.Helper()
		req, err := http.NewRequest(method, base+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		if bearer {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		return res.StatusCode
	}
	for _, base := range []string{bunBase, srv.URL} {
		if code := send(base, "POST", "/ui/api/unlock", `{"passphrase":"`+parityPass+`"}`, false); code != 200 {
			t.Fatalf("unlock %s: %d", base, code)
		}
	}
	lastUsed := regexp.MustCompile(`"lastUsedAt":"[^"]*"`)
	read := func(path string) string {
		t.Helper()
		enc, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		plain, err := vault.Decrypt(string(enc), parityPass)
		if err != nil {
			t.Fatal(err)
		}
		return lastUsed.ReplaceAllString(plain, `"lastUsedAt":""`)
	}
	steps := []struct{ method, path, body string }{
		{"PUT", "/v1/profiles/gmail/new", `{"credentials":{"zeta":"z","access_token":"a&b<c>","nested":{"d":1,"c":[{"f":1,"e":2}]},"n":1.50},"readOnly":true}`},
		{"PUT", "/v1/profiles/gmail/new", `{"credentials":{"second":true,"first":{"y":1,"x":2}}}`},
		{"PUT", "/v1/profiles/gmail/bare", `{"credentials":{"replaced":{"b":2,"a":1}},"readOnly":false}`},
		{"PATCH", "/v1/profiles/gmail/new", `{"name":"moved"}`},
		{"POST", "/v1/profiles/github/work/credentials", `{}`},
		{"DELETE", "/v1/profiles/gmail/moved", ``},
	}
	for _, step := range steps {
		b, g := send(bunBase, step.method, step.path, step.body, true), send(srv.URL, step.method, step.path, step.body, true)
		if b != g {
			t.Fatalf("%s %s: status bun=%d go=%d", step.method, step.path, b, g)
		}
		if b >= 300 {
			t.Fatalf("%s %s: status %d", step.method, step.path, b)
		}
		if bun, got := read(bunVault), read(goVault); got != bun {
			t.Fatalf("%s %s: the Go vault differs from Bun's\n bun: %s\n  go: %s", step.method, step.path, bun, got)
		}
	}
}
