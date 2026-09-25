package auth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/vault"
)

// Remote mode: this machine has no vault. AGENTIO_TOKEN (else the file
// `agentio login` writes) names a hub and a key. The env var wins.

var (
	fileTokenCache *string
	parsedToken    *TokenParts
	listingCache   *RemoteListing
)

func Reset() {
	fileTokenCache = nil
	parsedToken = nil
	listingCache = nil
}

type RemoteProfile struct {
	Service        string `json:"service"`
	Name           string `json:"name"`
	ReadOnly       bool   `json:"readOnly"`
	HasCredentials bool   `json:"hasCredentials"`
}

type RemoteListing struct {
	Profiles          []RemoteProfile `json:"profiles"`
	CanManageProfiles *bool           `json:"canManageProfiles"`
}

// TokenSource is where the hub token comes from: "env", "file", or "" in
// local mode.
func TokenSource() string {
	if strings.TrimSpace(os.Getenv("AGENTIO_TOKEN")) != "" {
		return "env"
	}
	if fileTokenCache == nil {
		b, err := os.ReadFile(vault.TokenPath())
		v := ""
		if err == nil {
			v = strings.TrimSpace(string(b))
		}
		fileTokenCache = &v
	}
	if *fileTokenCache == "" {
		return ""
	}
	return "file"
}

func RemoteToken() string {
	switch TokenSource() {
	case "env":
		return strings.TrimSpace(os.Getenv("AGENTIO_TOKEN"))
	case "file":
		return *fileTokenCache
	default:
		return ""
	}
}

// hubDepth keeps a hub request on the local vault. The credential handler and
// the remote client share a process in tests; without this, the handler would
// see AGENTIO_TOKEN and call itself.
var (
	hubMu    sync.Mutex
	hubDepth int
)

func EnterHub() {
	hubMu.Lock()
	hubDepth++
	hubMu.Unlock()
}

func LeaveHub() {
	hubMu.Lock()
	if hubDepth > 0 {
		hubDepth--
	}
	hubMu.Unlock()
}

func IsRemote() bool {
	hubMu.Lock()
	local := hubDepth > 0
	hubMu.Unlock()
	if local {
		return false
	}
	return TokenSource() != ""
}

func Hub() (TokenParts, error) {
	if parsedToken != nil {
		return *parsedToken, nil
	}
	parts, err := DecodeToken(RemoteToken())
	if err != nil {
		return TokenParts{}, err
	}
	parsedToken = &parts
	return parts, nil
}

// RemoteModeError is Bun's remoteModeError: the refusal names the hub, so a
// malformed token fails with its own error instead.
func RemoteModeError(what string) error {
	h, err := Hub()
	if err != nil {
		return err
	}
	return clierr.New(clierr.ConfigError,
		what+" is not available in remote mode",
		"This machine uses the vault hub at "+h.URL+". Manage profiles and keys there.")
}

func AssertLocal(what string) error {
	if IsRemote() {
		return RemoteModeError(what)
	}
	return nil
}

func SaveRemoteToken(token string) (string, error) {
	path := vault.TokenPath()
	if err := vault.AssertTestWritable(path, "token"); err != nil {
		return "", err
	}
	if err := os.MkdirAll(vault.ConfigDir(), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return "", err
	}
	Reset()
	return path, nil
}

func ClearRemoteToken() (bool, error) {
	path := vault.TokenPath()
	if _, err := os.Stat(path); err != nil {
		return false, nil
	}
	if err := vault.AssertTestWritable(path, "token"); err != nil {
		return false, err
	}
	if err := os.Remove(path); err != nil {
		return false, err
	}
	Reset()
	return true, nil
}

// Call is one JSON request to a hub.
type Call struct {
	Method string
	Body   any
	Token  string
}

func HubCall(hubURL, path string, call Call) (json.RawMessage, int, error) {
	if call.Method == "" {
		call.Method = http.MethodGet
	}
	var body io.Reader
	if call.Body != nil {
		raw, err := json.Marshal(call.Body)
		if err != nil {
			return nil, 0, err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(call.Method, hubURL+path, body)
	if err != nil {
		return nil, 0, err
	}
	if call.Token != "" {
		req.Header.Set("Authorization", "Bearer "+call.Token)
	}
	if call.Body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := plugins.NewHTTPClient(15 * time.Second)
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, clierr.New(clierr.NetworkError,
			fmt.Sprintf("Cannot reach the vault hub at %s: %s", hubURL, plugins.FetchFailure(err).Error()),
			"Check the network, and that the hub daemon is running")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode >= 300 {
		return nil, resp.StatusCode, hubError(resp.StatusCode, raw, hubURL, call.Method, path)
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, resp.StatusCode, nil
	}
	return raw, resp.StatusCode, nil
}

func hubError(status int, raw []byte, hubURL, method, path string) *clierr.Error {
	var body struct {
		Error      string `json:"error"`
		Code       string `json:"code"`
		Suggestion string `json:"suggestion"`
	}
	_ = json.Unmarshal(raw, &body)
	code := clierr.Code(body.Code)
	if body.Code == "" || !clierr.Known(body.Code) {
		code = clierr.HTTPStatusToCode(status)
	}
	detail := body.Error
	if detail == "" {
		detail = fmt.Sprintf("HTTP %d", status)
	}
	if code == clierr.NotFound && method == http.MethodPut {
		if service := serviceOfProfileRoute(path); service != "" {
			return clierr.New(clierr.ConfigError,
				fmt.Sprintf("The vault hub at %s does not know the service \"%s\"", hubURL, service),
				"The hub is running an older agentio. Update it, or unset the hub token to store this profile in the local vault.")
		}
	}
	switch code {
	case clierr.AuthFailed:
		return clierr.New(clierr.AuthFailed,
			"The vault hub rejected this token: "+detail,
			"Get a new token from the hub admin UI, or `agentio key create` on the hub host")
	case clierr.TokenExpired:
		return clierr.New(clierr.TokenExpired,
			"Re-authentication is needed on the vault host: "+detail,
			"Reauth the profile on the hub host, then retry")
	case clierr.VaultLocked:
		return clierr.New(clierr.ConfigError, "The vault is locked on the hub", "Unlock it at "+hubURL+"/ui")
	default:
		return clierr.New(code, detail, body.Suggestion)
	}
}

func serviceOfProfileRoute(path string) string {
	const prefix = "/v1/profiles/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(path, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return ""
	}
	s, err := url.PathUnescape(parts[0])
	if err != nil {
		return ""
	}
	return s
}

func hubRequest(path, method string, body any) (json.RawMessage, error) {
	h, err := Hub()
	if err != nil {
		return nil, err
	}
	raw, _, err := HubCall(h.URL, path, Call{Method: method, Body: body, Token: RemoteToken()})
	return raw, err
}

func profileRoute(service, name string) string {
	return "/v1/profiles/" + url.PathEscape(service) + "/" + url.PathEscape(name)
}

func RemoteListingOnce() (*RemoteListing, error) {
	if listingCache != nil {
		return listingCache, nil
	}
	raw, err := hubRequest("/v1/profiles", http.MethodGet, nil)
	if err != nil {
		return nil, err
	}
	var listing RemoteListing
	if err := json.Unmarshal(raw, &listing); err != nil {
		return nil, err
	}
	listingCache = &listing
	return listingCache, nil
}

func RemoteProfiles() ([]RemoteProfile, error) {
	l, err := RemoteListingOnce()
	if err != nil {
		return nil, err
	}
	return l.Profiles, nil
}

func RemoteCanManage() (*bool, error) {
	l, err := RemoteListingOnce()
	if err != nil {
		return nil, err
	}
	return l.CanManageProfiles, nil
}

func RemoteSaveProfile(service, name string, credentials map[string]any, readOnly *bool) error {
	body := map[string]any{"credentials": credentials}
	if readOnly != nil {
		body["readOnly"] = *readOnly
	}
	_, err := hubRequest(profileRoute(service, name), http.MethodPut, body)
	if err == nil {
		h, _ := Hub()
		fmt.Fprintf(os.Stderr, "Stored on the vault hub at %s\n", h.URL)
	}
	return err
}

// RemoteRename returns "ok", or "absent" when the hub says the profile is missing.
func RemoteRename(service, from, to string) (string, error) {
	return absentAsOutcome(hubRequest(profileRoute(service, from), http.MethodPatch, map[string]string{"name": to}))
}

func RemoteDelete(service, name string) (string, error) {
	return absentAsOutcome(hubRequest(profileRoute(service, name), http.MethodDelete, nil))
}

func absentAsOutcome(raw json.RawMessage, err error) (string, error) {
	if err == nil {
		return "ok", nil
	}
	if ce, ok := err.(*clierr.Error); ok && ce.Code == clierr.ProfileNotFound {
		return "absent", nil
	}
	return "", err
}

func RemoteCredentials(service, name string) (map[string]any, error) {
	raw, err := hubRequest(profileRoute(service, name)+"/credentials", http.MethodPost, nil)
	if err != nil {
		if ce, ok := err.(*clierr.Error); ok && ce.Code == clierr.NotFound {
			return nil, nil
		}
		return nil, err
	}
	var body struct {
		Credentials map[string]any `json:"credentials"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		return nil, err
	}
	return body.Credentials, nil
}
