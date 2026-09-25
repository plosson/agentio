// Package atlassian is the layer the Atlassian product plugins (confluence,
// jira) share: one OAuth app, the same authorize/token/site-selection flow,
// the camelCase credential map and its refresh, and the REST error shape.
// Each product keeps its own plugins.Plugin and id, and describes itself with
// an App. Nothing here writes the vault; the host persists what these
// functions return.
package atlassian

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

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugins"
)

const (
	authURL      = "https://auth.atlassian.com/authorize"
	tokenURL     = "https://auth.atlassian.com/oauth/token"
	resourcesURL = "https://api.atlassian.com/oauth/token/accessible-resources"
	// ClientID and SecretEnc are Bun ATLASSIAN_OAUTH_CONFIG (= JIRA_OAUTH_CONFIG).
	ClientID  = "cVyhx1kQLRUef6gr50M9cTDke7ZPL4CN"
	SecretEnc = "cFN1vM5KVVVCIkv9YlE5O0rerKJUkr-CszeusEVxofAH7W0evcCidzAB_OdTygfAcq2LjbN1IXK7ZiBBl3XrBsIO7RfxSGcEfHWpSbbHWxnKPP6H2iOoQZbOfns"
	// oauthPort is the callback port registered on the Atlassian app.
	oauthPort = 9999
)

// App is one Atlassian product's side of the shared flow.
type App struct {
	// ID is the CLI noun in the reauthentication log.
	ID string
	// DisplayName is the product name in the setup banner and site prompt.
	DisplayName string
	// SitesName is the product name in Bun's "No accessible … sites found".
	SitesName string
	// Scopes is the product's Bun *_SCOPES list.
	Scopes []string
	// SetupInfo is the Bun SetupResult info line.
	SetupInfo string
}

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

type tokenResult struct {
	accessToken  string
	refreshToken string
	expiresIn    int64
}

type site struct {
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

func secret() (string, error) {
	return obscure.Reveal(SecretEnc)
}

func randomState() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf)
}

func (a App) authorizeURL(redirect, state string) string {
	q := url.Values{}
	q.Set("audience", "api.atlassian.com")
	q.Set("client_id", ClientID)
	q.Set("scope", strings.Join(a.Scopes, " "))
	q.Set("redirect_uri", redirect)
	q.Set("state", state)
	q.Set("response_type", "code")
	q.Set("prompt", "consent")
	return authURL + "?" + q.Encode()
}

func requestToken(ctx context.Context, do fetchFunc, payload map[string]any, previousRefresh, failPrefix string) (tokenResult, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return tokenResult{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, bytes.NewReader(raw))
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
	if null, err := plugins.DecodeJSON(resp.StatusCode, body, &parsed); err != nil {
		return tokenResult{}, err
	} else if null {
		return tokenResult{}, jsvalue.TypeError(nil, "data.access_token")
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

func accessibleSites(ctx context.Context, do fetchFunc, access string) ([]site, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, resourcesURL, nil)
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
	var sites []site
	if _, err := plugins.DecodeJSON(resp.StatusCode, body, &sites); err != nil {
		return nil, err
	}
	return sites, nil
}

// chooseSite is Bun select<Product>Site: an interactiveSelect of the sites.
func (a App) chooseSite(setup *plugins.SetupContext, sites []site) (site, error) {
	choices := make([]plugins.Choice, len(sites))
	for i, s := range sites {
		choices[i] = plugins.Choice{Name: s.Name, Description: s.URL}
	}
	i, err := setup.Select(fmt.Sprintf("Select a %s site:", a.DisplayName), choices)
	if err != nil {
		return site{}, err
	}
	return sites[i], nil
}

// performOAuth is Bun perform<Product>OAuthFlow(select<Product>Site).
func (a App) performOAuth(ctx context.Context, setup *plugins.SetupContext) (oauthResult, error) {
	clientSecret, err := secret()
	if err != nil {
		return oauthResult{}, err
	}
	state := randomState()
	flow, err := setup.OAuth(ctx, plugins.OAuthSetupOptions{
		ServiceName:   "Atlassian",
		ExpectedState: state,
		Port:          oauthPort,
		AuthorizationURL: func(redirect string) string {
			return a.authorizeURL(redirect, state)
		},
	})
	if err != nil {
		return oauthResult{}, err
	}
	tokens, err := requestToken(ctx, setup.Fetch, map[string]any{
		"grant_type":    "authorization_code",
		"client_id":     ClientID,
		"client_secret": clientSecret,
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
		return oauthResult{}, fmt.Errorf("No accessible %s sites found. Make sure your app has the correct permissions.", a.SitesName)
	}
	selected := sites[0]
	if len(sites) > 1 {
		selected, err = a.chooseSite(setup, sites)
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

// Setup is the product's Bun profile.setup: the OAuth flow, then the
// credentials named after the site hostname.
func (a App) Setup(ctx context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log(fmt.Sprintf("\n%s OAuth Setup\n", a.DisplayName))
	result, err := a.performOAuth(ctx, setup)
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
		Info:                 a.SetupInfo,
	}, nil
}

// Reauthenticate is the product's Bun profile.reauthenticate: a new OAuth
// flow merged over the stored map, unknown fields kept.
func (a App) Reauthenticate(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
	setup.Log(fmt.Sprintf("\nRe-authenticating %s / %s...", a.ID, profileName))
	result, err := a.performOAuth(ctx, setup)
	if err != nil {
		return nil, err
	}
	setup.Log(fmt.Sprintf("  Done (%s)", result.siteURL))
	return credentialMap(creds, result), nil
}
