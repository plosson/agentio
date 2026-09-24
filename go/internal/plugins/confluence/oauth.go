package confluence

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugins"
)

const (
	atlassianAuthURL      = "https://auth.atlassian.com/authorize"
	atlassianTokenURL     = "https://auth.atlassian.com/oauth/token"
	atlassianResourcesURL = "https://api.atlassian.com/oauth/token/accessible-resources"
	atlassianClientID     = "cVyhx1kQLRUef6gr50M9cTDke7ZPL4CN"
	atlassianSecretEnc    = "cFN1vM5KVVVCIkv9YlE5O0rerKJUkr-CszeusEVxofAH7W0evcCidzAB_OdTygfAcq2LjbN1IXK7ZiBBl3XrBsIO7RfxSGcEfHWpSbbHWxnKPP6H2iOoQZbOfns"
	// oauthPort is the callback port registered on the Atlassian app.
	oauthPort = 9999
)

var confluenceScopes = []string{
	"read:page:confluence",
	"write:page:confluence",
	"read:space:confluence",
	"read:comment:confluence",
	"write:comment:confluence",
	"search:confluence",
	"read:me",
	"offline_access",
}

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

type tokenResult struct {
	accessToken  string
	refreshToken string
	expiresIn    int64
}

type atlassianSite struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	AvatarURL string   `json:"avatarUrl"`
}

type oauthResult struct {
	accessToken  string
	refreshToken string
	expiryDate   int64
	cloudID      string
	siteURL      string
}

func atlassianSecret() (string, error) {
	return obscure.Reveal(atlassianSecretEnc)
}

func defaultFetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	return http.DefaultClient.Do(req.WithContext(ctx))
}

func randomState() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf)
}

func authorizeURL(redirect, state string) string {
	q := url.Values{}
	q.Set("audience", "api.atlassian.com")
	q.Set("client_id", atlassianClientID)
	q.Set("scope", strings.Join(confluenceScopes, " "))
	q.Set("redirect_uri", redirect)
	q.Set("state", state)
	q.Set("response_type", "code")
	q.Set("prompt", "consent")
	return atlassianAuthURL + "?" + q.Encode()
}

func requestToken(ctx context.Context, do fetchFunc, payload map[string]any, previousRefresh, failPrefix string) (tokenResult, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return tokenResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, atlassianTokenURL, bytes.NewReader(raw))
	if err != nil {
		return tokenResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := do(ctx, req)
	if err != nil {
		return tokenResult{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return tokenResult{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return tokenResult{}, fmt.Errorf("%s: %s", failPrefix, string(body))
	}
	var parsed struct {
		AccessToken  string  `json:"access_token"`
		RefreshToken *string `json:"refresh_token"`
		ExpiresIn    float64 `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return tokenResult{}, err
	}
	// Atlassian omits the refresh token when it is not rotating. Bun keeps the previous one.
	rt := previousRefresh
	if parsed.RefreshToken != nil && *parsed.RefreshToken != "" {
		rt = *parsed.RefreshToken
	}
	return tokenResult{
		accessToken:  parsed.AccessToken,
		refreshToken: rt,
		expiresIn:    int64(parsed.ExpiresIn),
	}, nil
}

func accessibleSites(ctx context.Context, do fetchFunc, access string) ([]atlassianSite, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, atlassianResourcesURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Accept", "application/json")
	resp, err := do(ctx, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Failed to get accessible resources: %s", string(body))
	}
	var sites []atlassianSite
	if err := json.Unmarshal(body, &sites); err != nil {
		return nil, err
	}
	return sites, nil
}

func chooseSite(setup *plugins.SetupContext, sites []atlassianSite) (atlassianSite, error) {
	var b strings.Builder
	b.WriteString("Select a Confluence site:")
	for i, site := range sites {
		fmt.Fprintf(&b, "\n  %d) %s — %s", i+1, site.Name, site.URL)
	}
	answer, err := setup.Prompt(b.String(), false)
	answer = strings.TrimSpace(answer)
	if err != nil || answer == "" {
		return atlassianSite{}, setup.Fail(
			"INVALID_PARAMS",
			"Interactive input required but not running in terminal",
			"Run this command in an interactive terminal",
		)
	}
	if n, err := strconv.Atoi(answer); err == nil && n >= 1 && n <= len(sites) {
		return sites[n-1], nil
	}
	for _, site := range sites {
		if answer == site.Name || answer == site.URL || answer == site.ID {
			return site, nil
		}
	}
	return atlassianSite{}, setup.Fail(
		"INVALID_PARAMS",
		fmt.Sprintf("Unknown Confluence site %q", answer),
		"Choose one of the listed sites",
	)
}

func performOAuth(ctx context.Context, setup *plugins.SetupContext) (oauthResult, error) {
	secret, err := atlassianSecret()
	if err != nil {
		return oauthResult{}, err
	}
	state := randomState()
	flow, err := setup.OAuth(ctx, plugins.OAuthSetupOptions{
		ServiceName:   "Atlassian",
		ExpectedState: state,
		Port:          oauthPort,
		AuthorizationURL: func(redirect string) string {
			return authorizeURL(redirect, state)
		},
	})
	if err != nil {
		return oauthResult{}, err
	}
	tokens, err := requestToken(ctx, setup.Fetch, map[string]any{
		"grant_type":    "authorization_code",
		"client_id":     atlassianClientID,
		"client_secret": secret,
		"code":          flow.Code,
		"redirect_uri":  flow.RedirectURI,
	}, "", "Failed to exchange code for tokens")
	if err != nil {
		return oauthResult{}, err
	}
	sites, err := accessibleSites(ctx, setup.Fetch, tokens.accessToken)
	if err != nil {
		return oauthResult{}, err
	}
	if len(sites) == 0 {
		return oauthResult{}, fmt.Errorf("No accessible Confluence sites found. Make sure your app has the correct permissions.")
	}
	selected := sites[0]
	if len(sites) > 1 {
		selected, err = chooseSite(setup, sites)
		if err != nil {
			return oauthResult{}, err
		}
	}
	return oauthResult{
		accessToken:  tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiryDate:   time.Now().UnixMilli() + tokens.expiresIn*1000,
		cloudID:      selected.ID,
		siteURL:      selected.URL,
	}, nil
}

func siteHostname(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return "", fmt.Errorf("invalid site URL: %s", raw)
	}
	return parsed.Hostname(), nil
}

func credentialMap(prev map[string]any, result oauthResult) map[string]any {
	out := copyMap(prev)
	out["accessToken"] = result.accessToken
	out["refreshToken"] = result.refreshToken
	out["expiryDate"] = jsonNum(result.expiryDate)
	out["cloudId"] = result.cloudID
	out["siteUrl"] = result.siteURL
	return out
}

func setup(ctx context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("\nConfluence OAuth Setup\n")
	result, err := performOAuth(ctx, setup)
	if err != nil {
		return nil, err
	}
	setup.Log(fmt.Sprintf("\nAuthorized for site: %s\n", result.siteURL))
	host, err := siteHostname(result.siteURL)
	if err != nil {
		return nil, err
	}
	return &plugins.SetupResult{
		Credentials:          credentialMap(nil, result),
		SuggestedProfileName: host,
		Info:                 "Test with: agentio confluence spaces",
	}, nil
}

func reauth(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
	setup.Log(fmt.Sprintf("\nRe-authenticating confluence / %s...", profileName))
	result, err := performOAuth(ctx, setup)
	if err != nil {
		return nil, err
	}
	setup.Log(fmt.Sprintf("  Done (%s)", result.siteURL))
	return credentialMap(creds, result), nil
}

func applies(creds map[string]any) bool {
	token, ok := creds["refreshToken"].(string)
	return ok && token != ""
}

// stale is Bun's `expiryDate !== undefined && now + bufferMs >= expiryDate`.
// A stored null coerces to 0 in JavaScript, so it counts as expired.
func stale(creds map[string]any, nowMs, bufferMs int64) bool {
	raw, present := creds["expiryDate"]
	if !present {
		return false
	}
	if raw == nil {
		return true
	}
	expiry, ok := asInt64(raw)
	if !ok {
		return false
	}
	return nowMs+bufferMs >= expiry
}

func refresh(ctx context.Context, creds map[string]any) (map[string]any, error) {
	secret, err := atlassianSecret()
	if err != nil {
		return nil, err
	}
	old := str(creds, "refreshToken")
	next, err := requestToken(ctx, defaultFetch, map[string]any{
		"grant_type":    "refresh_token",
		"client_id":     atlassianClientID,
		"client_secret": secret,
		"refresh_token": old,
	}, old, "Failed to refresh token")
	if err != nil {
		return nil, err
	}
	out := copyMap(creds)
	out["accessToken"] = next.accessToken
	out["refreshToken"] = next.refreshToken
	out["expiryDate"] = jsonNum(time.Now().UnixMilli() + next.expiresIn*1000)
	return out, nil
}
