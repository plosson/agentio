package github

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugins"
)

const (
	githubAuthorizeURL = "https://github.com/login/oauth/authorize"
	githubTokenURL     = "https://github.com/login/oauth/access_token"
	githubClientID     = "Ov23liR1X63IRAf6eONJ"
	githubSecretEnc    = "Sztvs0AEbI5enapA40GFdqQc4RMgf8tmrMGXZ7RQIxYnuKmllPl8bZluGh5e15QfTjRe7HwZ5Bc"
)

var githubScopes = []string{"repo"}

// randomState is Bun's Math.random().toString(36).substring(7): a short
// base-36 string.
func randomState() string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	var b strings.Builder
	for i := 0; i < 6; i++ {
		n, err := rand.Int(rand.Reader, big.NewInt(36))
		if err != nil {
			b.WriteByte('x')
			continue
		}
		b.WriteByte(digits[n.Int64()])
	}
	return b.String()
}

func authorizeURL(redirect, state string) string {
	q := jsvalue.NewSearchParams()
	q.Set("client_id", githubClientID)
	q.Set("redirect_uri", redirect)
	q.Set("scope", strings.Join(githubScopes, " "))
	q.Set("state", state)
	return githubAuthorizeURL + "?" + q.String()
}

// performOAuth is performGitHubOAuthFlow: the code flow, then a JSON token
// exchange. Its failures are plain errors, as Bun throws `new Error(...)`.
func performOAuth(ctx context.Context, setup *plugins.SetupContext) (string, error) {
	secret, err := obscure.Reveal(githubSecretEnc)
	if err != nil {
		return "", err
	}
	state := randomState()
	flow, err := setup.OAuth(ctx, plugins.OAuthSetupOptions{
		ServiceName:   "GitHub",
		ExpectedState: state,
		AuthorizationURL: func(redirect string) string {
			return authorizeURL(redirect, state)
		},
	})
	if err != nil {
		return "", err
	}
	payload := jsvalue.NewObject()
	payload.Set("client_id", githubClientID)
	payload.Set("client_secret", secret)
	payload.Set("code", flow.Code)
	payload.Set("redirect_uri", flow.RedirectURI)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, githubTokenURL, bytes.NewReader(jsvalue.Stringify(payload)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := setup.Fetch(ctx, req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	var parsed struct {
		AccessToken      any `json:"access_token"`
		Error            any `json:"error"`
		ErrorDescription any `json:"error_description"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", err
	}
	if jsvalue.Truthy(parsed.Error) || !jsvalue.Truthy(parsed.AccessToken) {
		switch {
		case jsvalue.Truthy(parsed.ErrorDescription):
			return "", errors.New(jsvalue.String(parsed.ErrorDescription))
		case jsvalue.Truthy(parsed.Error):
			return "", errors.New(jsvalue.String(parsed.Error))
		}
		return "", errors.New("Failed to get access token")
	}
	return jsvalue.String(parsed.AccessToken), nil
}
