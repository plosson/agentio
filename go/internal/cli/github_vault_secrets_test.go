package cli

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
	"golang.org/x/crypto/nacl/box"
)

type ghHit struct {
	method, path, auth string
	body               []byte
}

// fakeGitHubAPI serves the secrets endpoints and routes api.github.com to
// itself; any other host fails, so nothing leaves the test.
func fakeGitHubAPI(t *testing.T, pub *[32]byte) (*[]ghHit, *sync.Mutex) {
	t.Helper()
	var mu sync.Mutex
	hits := []ghHit{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		hits = append(hits, ghHit{r.Method, r.URL.Path, r.Header.Get("Authorization"), raw})
		mu.Unlock()
		switch {
		case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/actions/secrets/public-key"):
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"key_id": "kid-1", "key": base64.StdEncoding.EncodeToString(pub[:])})
		case r.Method == "PUT":
			w.WriteHeader(201)
			_, _ = w.Write([]byte("{}"))
		case r.Method == "DELETE":
			w.WriteHeader(204)
		default:
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	prev := http.DefaultTransport
	http.DefaultTransport = roundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "api.github.com" {
			return nil, io.ErrUnexpectedEOF
		}
		out := req.Clone(req.Context())
		out.URL.Scheme, out.URL.Host, out.Host = target.Scheme, target.Host, target.Host
		return srv.Client().Transport.RoundTrip(out)
	})
	t.Cleanup(func() { http.DefaultTransport = prev })
	return &hits, &mu
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func githubVault(t *testing.T) {
	t.Helper()
	initCLI(t)
	if code, _, errOut := run(t, "vault", "init", "--passphrase", "test-pass-123", "--no-migrate"); code != 0 {
		t.Fatal(errOut)
	}
}

func TestGitHubHelpListsTheBunLeaves(t *testing.T) {
	initCLI(t)
	_, out, _ := run(t, "github", "--help")
	for _, leaf := range []string{"install", "uninstall", "profile"} {
		if !strings.Contains(out, "\n  "+leaf+" ") {
			t.Fatalf("github help lacks %s:\n%s", leaf, out)
		}
	}
	_, out, _ = run(t, "github", "install", "--help")
	if !strings.Contains(out, "install <repo>") || !strings.Contains(out, "--profile string") ||
		!strings.Contains(out, "agentio github install octocat/hello-world --profile work") || strings.Contains(out, "--json") {
		t.Fatalf("install help:\n%s", out)
	}
}

func TestGitHubInstallSealsAnExportOfTheWholeVault(t *testing.T) {
	githubVault(t)
	pub, priv, _ := box.GenerateKey(rand.Reader)
	hits, mu := fakeGitHubAPI(t, pub)
	if err := profile.Save("github", "octocat", map[string]any{"accessToken": "gho_1", "username": "octocat", "email": nil}, profile.SaveOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := profile.Save("acme", "ro-one", map[string]any{"account": "ada"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}); err != nil {
		t.Fatal(err)
	}
	code, out, errOut := run(t, "github", "install", "octocat/hello")
	if code != 0 {
		t.Fatalf("code %d\n%s", code, errOut)
	}
	wantOut := "\nInstalled AGENTIO_KEY and AGENTIO_CONFIG to octocat/hello\n\nIn your GitHub Actions workflow, use:\n" +
		"  env:\n    AGENTIO_KEY: ${{ secrets.AGENTIO_KEY }}\n    AGENTIO_CONFIG: ${{ secrets.AGENTIO_CONFIG }}\n"
	wantErr := "Using GitHub profile: octocat\nInstalling secrets to: octocat/hello\n\nSetting AGENTIO_KEY...\nSetting AGENTIO_CONFIG...\n"
	if out != wantOut || errOut != wantErr {
		t.Fatalf("stdout %q\nstderr %q", out, errOut)
	}
	mu.Lock()
	defer mu.Unlock()
	var paths []string
	secrets := map[string]string{}
	for _, h := range *hits {
		paths = append(paths, h.method+" "+h.path)
		if h.auth != "Bearer gho_1" {
			t.Fatalf("auth %q", h.auth)
		}
		if h.method == "PUT" {
			var body struct {
				EncryptedValue string `json:"encrypted_value"`
				KeyID          string `json:"key_id"`
			}
			_ = json.Unmarshal(h.body, &body)
			sealed, _ := base64.StdEncoding.DecodeString(body.EncryptedValue)
			plain, ok := box.OpenAnonymous(nil, sealed, pub, priv)
			if !ok || body.KeyID != "kid-1" {
				t.Fatalf("PUT %s: bad sealed body %s", h.path, h.body)
			}
			secrets[h.path[strings.LastIndex(h.path, "/")+1:]] = string(plain)
		}
	}
	if strings.Join(paths, ",") != "GET /repos/octocat/hello/actions/secrets/public-key,PUT /repos/octocat/hello/actions/secrets/AGENTIO_KEY,"+
		"GET /repos/octocat/hello/actions/secrets/public-key,PUT /repos/octocat/hello/actions/secrets/AGENTIO_CONFIG" {
		t.Fatalf("requests %v", paths)
	}
	// AGENTIO_CONFIG opens with AGENTIO_KEY and holds the vault as stored,
	// read-only flags included (Bun exports loadConfig() whole).
	plain, err := vault.Decrypt(secrets["AGENTIO_CONFIG"], secrets["AGENTIO_KEY"])
	if err != nil {
		t.Fatal(err)
	}
	var blob struct {
		Version int `json:"version"`
		Config  struct {
			Profiles map[string][]map[string]any `json:"profiles"`
		} `json:"config"`
		Credentials map[string]map[string]map[string]any `json:"credentials"`
	}
	if err := json.Unmarshal([]byte(plain), &blob); err != nil {
		t.Fatal(err)
	}
	if blob.Version != 1 || blob.Credentials["github"]["octocat"]["accessToken"] != "gho_1" ||
		blob.Credentials["acme"]["ro-one"]["account"] != "ada" || blob.Config.Profiles["acme"][0]["readOnly"] != true {
		t.Fatalf("export %s", plain)
	}
}

func TestGitHubUninstallDeletesBothSecrets(t *testing.T) {
	githubVault(t)
	pub, _, _ := box.GenerateKey(rand.Reader)
	hits, mu := fakeGitHubAPI(t, pub)
	_ = profile.Save("github", "octocat", map[string]any{"accessToken": "gho_1"}, profile.SaveOptions{})
	_ = profile.Save("github", "work", map[string]any{"accessToken": "gho_2"}, profile.SaveOptions{})
	code, out, errOut := run(t, "github", "uninstall", "octocat/hello", "--profile", "work")
	if code != 0 || out != "\nRemoved AGENTIO_KEY and AGENTIO_CONFIG from octocat/hello\n" ||
		errOut != "Using GitHub profile: work\nRemoving secrets from: octocat/hello\n\nDeleting AGENTIO_KEY...\nDeleting AGENTIO_CONFIG...\n" {
		t.Fatalf("code %d\nstdout %q\nstderr %q", code, out, errOut)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*hits) != 2 || (*hits)[0].method != "DELETE" || (*hits)[1].path != "/repos/octocat/hello/actions/secrets/AGENTIO_CONFIG" || (*hits)[1].auth != "Bearer gho_2" {
		t.Fatalf("%#v", *hits)
	}
}

func TestGitHubSecretCommandsRefuseBeforeCallingGitHub(t *testing.T) {
	githubVault(t)
	pub, _, _ := box.GenerateKey(rand.Reader)
	hits, mu := fakeGitHubAPI(t, pub)

	// No profile yet.
	code, _, errOut := run(t, "github", "install", "octocat/hello")
	if code != 3 || errOut != "Error [PROFILE_NOT_FOUND]: No github profile configured\nSuggestion: Run: agentio github profile add\n" {
		t.Fatalf("code %d %q", code, errOut)
	}
	_ = profile.Save("github", "ro", map[string]any{"accessToken": "gho_1"}, profile.SaveOptions{ReadOnlySet: true, ReadOnly: true})
	for _, c := range []struct{ cmd, op string }{{"install", "install secrets"}, {"uninstall", "uninstall secrets"}} {
		code, out, errOut := run(t, "github", c.cmd, "octocat/hello")
		want := "Error [PERMISSION_DENIED]: Cannot " + c.op + ": profile \"ro\" is read-only\n" +
			"Suggestion: To modify this profile's access: agentio github profile update --profile ro --no-read-only\n"
		if code != 2 || out != "" || errOut != want {
			t.Fatalf("%s: code %d %q", c.cmd, code, errOut)
		}
	}
	for _, repo := range []string{"octocat", "octocat/", "/hello", "a/b/c"} {
		code, _, errOut := run(t, "github", "uninstall", repo)
		want := "Error [INVALID_PARAMS]: Invalid repository format: \"" + repo + "\"\nSuggestion: Use the format: owner/repo (e.g., octocat/hello-world)\n"
		if code != 1 || errOut != want {
			t.Fatalf("%s: code %d %q", repo, code, errOut)
		}
	}
	code, _, errOut = run(t, "github", "install", "octocat/hello", "--profile", "nope")
	if code != 3 || !strings.Contains(errOut, `Profile "nope" not found for github`) {
		t.Fatalf("code %d %q", code, errOut)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*hits) != 0 {
		t.Fatalf("a refused command reached GitHub: %#v", *hits)
	}
}

func TestGitHubInstallReportsTheAPIError(t *testing.T) {
	githubVault(t)
	_ = profile.Save("github", "octocat", map[string]any{"accessToken": "gho_1"}, profile.SaveOptions{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	prev := http.DefaultTransport
	http.DefaultTransport = roundTrip(func(req *http.Request) (*http.Response, error) {
		out := req.Clone(req.Context())
		out.URL.Scheme, out.URL.Host, out.Host = target.Scheme, target.Host, target.Host
		return srv.Client().Transport.RoundTrip(out)
	})
	t.Cleanup(func() { http.DefaultTransport = prev })
	code, out, errOut := run(t, "github", "install", "octocat/missing")
	if code != 5 || out != "" || !strings.HasSuffix(errOut, "\nSetting AGENTIO_KEY...\nError [NOT_FOUND]: Not found: Not Found\n"+
		"Suggestion: Check that the repository exists and you have access to it\n") {
		t.Fatalf("code %d\nstdout %q\nstderr %q", code, out, errOut)
	}
}
