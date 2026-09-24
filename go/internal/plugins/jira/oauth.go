package jira

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/oauth"
)

// Bun: src/config/credentials.ts JIRA_OAUTH_CONFIG + src/plugins/jira/oauth.ts
const (
	jiraClientID     = "cVyhx1kQLRUef6gr50M9cTDke7ZPL4CN"
	jiraClientSecret = "cFN1vM5KVVVCIkv9YlE5O0rerKJUkr-CszeusEVxofAH7W0evcCidzAB_OdTygfAcq2LjbN1IXK7ZiBBl3XrBsIO7RfxSGcEfHWpSbbHWxnKPP6H2iOoQZbOfns"
	atlassianAuthURL = "https://auth.atlassian.com/authorize"
	atlassianTokenURL = "https://auth.atlassian.com/oauth/token"
	atlassianResourcesURL = "https://api.atlassian.com/oauth/token/accessible-resources"
	oauthPort = 9999
)

var jiraScopes = []string{
	"read:jira-work",
	"write:jira-work",
	"read:me",
	"offline_access",
}

// Credentials mirrors Bun JiraCredentials (vault wire shape — camelCase).
type Credentials struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiryDate   int64  `json:"expiryDate"`
	CloudID      string `json:"cloudId"`
	SiteURL      string `json:"siteUrl"`
}

func (c Credentials) ToMap() map[string]any {
	return map[string]any{
		"accessToken":  c.AccessToken,
		"refreshToken": c.RefreshToken,
		"expiryDate":   c.ExpiryDate,
		"cloudId":      c.CloudID,
		"siteUrl":      c.SiteURL,
	}
}

func CredentialsFromMap(m map[string]any) Credentials {
	c := Credentials{}
	if v, ok := m["accessToken"].(string); ok {
		c.AccessToken = v
	}
	if v, ok := m["refreshToken"].(string); ok {
		c.RefreshToken = v
	}
	if v, ok := m["cloudId"].(string); ok {
		c.CloudID = v
	}
	if v, ok := m["siteUrl"].(string); ok {
		c.SiteURL = v
	}
	switch v := m["expiryDate"].(type) {
	case float64:
		c.ExpiryDate = int64(v)
	case int64:
		c.ExpiryDate = v
	case json.Number:
		n, _ := v.Int64()
		c.ExpiryDate = n
	}
	return c
}

type atlassianSite struct {
	ID   string `json:"id"`
	URL  string `json:"url"`
	Name string `json:"name"`
}

// PerformOAuth mirrors Bun performJiraOAuthFlow (Atlassian 3LO loopback on :9999).
func PerformOAuth(ctx context.Context) (Credentials, error) {
	secret, err := oauth.Reveal(jiraClientSecret)
	if err != nil {
		return Credentials{}, fmt.Errorf("reveal jira client secret: %w", err)
	}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", oauthPort))
	if err != nil {
		return Credentials{}, fmt.Errorf("listen oauth port %d: %w (is another agentio jira oauth running?)", oauthPort, err)
	}
	defer ln.Close()

	redirectURI := fmt.Sprintf("http://localhost:%d/callback", oauthPort)
	state := fmt.Sprintf("%d", time.Now().UnixNano())

	authURL, _ := url.Parse(atlassianAuthURL)
	q := authURL.Query()
	q.Set("audience", "api.atlassian.com")
	q.Set("client_id", jiraClientID)
	q.Set("scope", strings.Join(jiraScopes, " "))
	q.Set("redirect_uri", redirectURI)
	q.Set("state", state)
	q.Set("response_type", "code")
	q.Set("prompt", "consent")
	authURL.RawQuery = q.Encode()

	codeCh := make(chan string, 1)
	errCh := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, r *http.Request) {
		if e := r.URL.Query().Get("error"); e != "" {
			_, _ = w.Write([]byte("<html><body><h1>Authorization Failed</h1></body></html>"))
			errCh <- fmt.Errorf("oauth error: %s", e)
			return
		}
		if r.URL.Query().Get("state") != state {
			_, _ = w.Write([]byte("<html><body><h1>Invalid State</h1></body></html>"))
			errCh <- fmt.Errorf("oauth state mismatch")
			return
		}
		code := r.URL.Query().Get("code")
		if code == "" {
			_, _ = w.Write([]byte("<html><body><h1>Missing Code</h1></body></html>"))
			errCh <- fmt.Errorf("missing code")
			return
		}
		_, _ = w.Write([]byte("<html><body><h1>Authorization Successful!</h1><p>You can close this window.</p></body></html>"))
		codeCh <- code
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	fmt.Fprintf(os.Stderr, "\nOpen this URL to authorize Jira:\n\n  %s\n\nWaiting for redirect on localhost:%d ...\n", authURL.String(), oauthPort)
	launchBrowser(authURL.String())

	var code string
	select {
	case code = <-codeCh:
	case err = <-errCh:
		return Credentials{}, err
	case <-ctx.Done():
		return Credentials{}, ctx.Err()
	case <-time.After(5 * time.Minute):
		return Credentials{}, fmt.Errorf("oauth timed out after 5 minutes")
	}

	tok, err := exchangeCode(ctx, code, secret, redirectURI)
	if err != nil {
		return Credentials{}, err
	}
	sites, err := accessibleResources(ctx, tok.AccessToken)
	if err != nil {
		return Credentials{}, err
	}
	if len(sites) == 0 {
		return Credentials{}, fmt.Errorf("no accessible Jira sites; check app permissions")
	}
	site := sites[0]
	if len(sites) > 1 {
		fmt.Fprintf(os.Stderr, "Multiple Atlassian sites found; using first: %s (%s)\n", site.Name, site.URL)
		for i, s := range sites {
			fmt.Fprintf(os.Stderr, "  [%d] %s — %s\n", i, s.Name, s.URL)
		}
	}

	return Credentials{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		ExpiryDate:   time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second).UnixMilli(),
		CloudID:      site.ID,
		SiteURL:      site.URL,
	}, nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
}

func exchangeCode(ctx context.Context, code, secret, redirectURI string) (*tokenResponse, error) {
	body, _ := json.Marshal(map[string]string{
		"grant_type":    "authorization_code",
		"client_id":     jiraClientID,
		"client_secret": secret,
		"code":          code,
		"redirect_uri":  redirectURI,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, atlassianTokenURL, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("token exchange failed: %s", string(raw))
	}
	var tok tokenResponse
	if err := json.Unmarshal(raw, &tok); err != nil {
		return nil, err
	}
	return &tok, nil
}

func accessibleResources(ctx context.Context, accessToken string) ([]atlassianSite, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, atlassianResourcesURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("accessible-resources: %s", string(raw))
	}
	var sites []atlassianSite
	if err := json.NewDecoder(resp.Body).Decode(&sites); err != nil {
		return nil, err
	}
	return sites, nil
}

func launchBrowser(u string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	_ = cmd.Start()
}
