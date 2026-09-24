package google

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugins"
	"golang.org/x/oauth2"
	googleoauth "golang.org/x/oauth2/google"
)

const (
	clientID     = "931954287794-4rflctl8lotok5d6rnd4o6teuk02lked.apps.googleusercontent.com"
	clientSecret = "H2nByOfMnoQDg9BIGMyt_hznzMMTq-Or4wsZwiqT1ldl6z7bTMIdk9L8rDzQJ4l0i_pA"
	// authURL is what google-auth-library generateAuthUrl targets.
	authURL     = "https://accounts.google.com/o/oauth2/v2/auth"
	userInfoURL = "https://www.googleapis.com/oauth2/v2/userinfo"
)

// Scopes is Bun oauth.ts SCOPES, keyed by the OAuthService name a product
// passes to PerformOAuth (gdrive picks gdrive-readonly or gdrive-full).
var Scopes = map[string][]string{
	"gmail": {
		"https://www.googleapis.com/auth/gmail.readonly",
		"https://www.googleapis.com/auth/gmail.send",
		"https://www.googleapis.com/auth/gmail.compose",
		"https://www.googleapis.com/auth/gmail.modify",
		"https://www.googleapis.com/auth/gmail.settings.basic",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gchat": {
		"https://www.googleapis.com/auth/chat.messages.create",
		"https://www.googleapis.com/auth/chat.messages.readonly",
		"https://www.googleapis.com/auth/chat.spaces.readonly",
		"https://www.googleapis.com/auth/chat.memberships.readonly",
		"https://www.googleapis.com/auth/directory.readonly",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gdocs": {
		"https://www.googleapis.com/auth/documents",
		"https://www.googleapis.com/auth/drive.file",
		"https://www.googleapis.com/auth/drive.readonly",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gdrive-readonly": {
		"https://www.googleapis.com/auth/drive.readonly",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gdrive-full": {
		"https://www.googleapis.com/auth/drive",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gcal": {
		"https://www.googleapis.com/auth/calendar",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gtasks": {
		"https://www.googleapis.com/auth/tasks",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gsheets": {
		"https://www.googleapis.com/auth/spreadsheets",
		"https://www.googleapis.com/auth/drive.file",
		"https://www.googleapis.com/auth/drive.readonly",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gslides": {
		"https://www.googleapis.com/auth/presentations",
		"https://www.googleapis.com/auth/drive.file",
		"https://www.googleapis.com/auth/drive.readonly",
		"https://www.googleapis.com/auth/userinfo.email",
	},
	"gscript": {
		"https://www.googleapis.com/auth/script.projects",
		"https://www.googleapis.com/auth/drive",
		"https://www.googleapis.com/auth/userinfo.email",
	},
}

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

func defaultFetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	return http.DefaultClient.Do(req.WithContext(ctx))
}

// AuthorizeURL is google-auth-library generateAuthUrl({ access_type:
// 'offline', scope, prompt: 'consent' }), parameters in the same order.
func AuthorizeURL(scopes []string, redirectURI string) string {
	enc := func(s string) string { return strings.ReplaceAll(url.QueryEscape(s), "+", "%20") }
	return authURL +
		"?access_type=offline" +
		"&scope=" + enc(strings.Join(scopes, " ")) +
		"&prompt=consent" +
		"&response_type=code" +
		"&client_id=" + enc(clientID) +
		"&redirect_uri=" + enc(redirectURI)
}

func oauthConfig(ctx context.Context, redirectURI string) (*oauth2.Config, error) {
	secret, err := obscure.Reveal(clientSecret)
	if err != nil {
		return nil, err
	}
	tokenURL := googleoauth.Endpoint.TokenURL
	if ep := endpointsFrom(ctx).Token; ep != "" {
		tokenURL = ep
	}
	return &oauth2.Config{
		ClientID:     clientID,
		ClientSecret: secret,
		RedirectURL:  redirectURI,
		// google-auth-library posts the secret in the body (ClientSecretPost).
		Endpoint: oauth2.Endpoint{AuthURL: authURL, TokenURL: tokenURL, AuthStyle: oauth2.AuthStyleInParams},
	}, nil
}

// tokenContext routes x/oauth2's token request through fetch with
// google-auth-library's retry policy (POST included).
func tokenContext(ctx context.Context, fetch fetchFunc) context.Context {
	client := &http.Client{Transport: &retryTransport{base: fetchTransport(fetch), methods: tokenRetryMethods}}
	return context.WithValue(ctx, oauth2.HTTPClient, client)
}

// PerformOAuth is Bun performOAuthFlow(service): the host's localhost callback,
// then the code exchange. service is a Scopes key.
func PerformOAuth(ctx context.Context, setup *plugins.SetupContext, service string) (Tokens, error) {
	scopes, ok := Scopes[service]
	if !ok {
		return Tokens{}, fmt.Errorf("unknown Google OAuth service: %s", service)
	}
	flow, err := setup.OAuth(ctx, plugins.OAuthSetupOptions{
		ServiceName:      "Google",
		AuthorizationURL: func(redirect string) string { return AuthorizeURL(scopes, redirect) },
	})
	if err != nil {
		return Tokens{}, err
	}
	conf, err := oauthConfig(ctx, flow.RedirectURI)
	if err != nil {
		return Tokens{}, err
	}
	tok, err := conf.Exchange(tokenContext(ctx, setup.Fetch), flow.Code)
	if err != nil {
		return Tokens{}, tokenError(err)
	}
	return Tokens{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		ExpiryDate:   expiryMs(tok),
		TokenType:    orBearer(tok.TokenType),
		Scope:        scopeOf(tok),
	}, nil
}

// refreshTokens is Bun refreshGoogleAccessToken. google-auth-library's
// refreshAccessToken always puts the stored refresh token back on the result,
// so a rotated token in the response is ignored, as in Bun.
func refreshTokens(ctx context.Context, stored Tokens) (Tokens, error) {
	if stored.RefreshToken == "" {
		return Tokens{}, errors.New("no refresh token stored")
	}
	conf, err := oauthConfig(ctx, "")
	if err != nil {
		return Tokens{}, err
	}
	tok, err := conf.TokenSource(tokenContext(ctx, defaultFetch), &oauth2.Token{RefreshToken: stored.RefreshToken}).Token()
	if err != nil {
		return Tokens{}, tokenError(err)
	}
	scope := scopeOf(tok)
	if scope == "" {
		scope = stored.Scope
	}
	return Tokens{
		AccessToken:  tok.AccessToken,
		RefreshToken: stored.RefreshToken,
		ExpiryDate:   expiryMs(tok),
		TokenType:    orBearer(tok.TokenType),
		Scope:        scope,
	}, nil
}

// FetchUserEmail is Bun fetchGoogleUserEmail.
func FetchUserEmail(ctx context.Context, fetch func(context.Context, *http.Request) (*http.Response, error), accessToken string) (string, error) {
	target := userInfoURL
	if ep := endpointsFrom(ctx).UserInfo; ep != "" {
		target = ep
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := fetch(ctx, req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("Failed to fetch user info: %d", resp.StatusCode)
	}
	var data struct {
		Email string `json:"email"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return "", err
	}
	if data.Email == "" {
		return "", errors.New("No email returned from userinfo endpoint")
	}
	return data.Email, nil
}

// Reauthenticate is Bun reauthenticateGoogleSnake / reauthenticateGoogleCamel:
// a new OAuth flow for service, merged over the stored map under keys, with
// the account email. A product with its own rule (gchat webhooks, gdrive access
// level) composes PerformOAuth, FetchUserEmail and Keys.Merge itself.
func Reauthenticate(service string, keys Keys) func(context.Context, map[string]any, string, *plugins.SetupContext) (map[string]any, error) {
	return func(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
		setup.Log(fmt.Sprintf("\nRe-authenticating %s / %s...", service, profileName))
		tokens, err := PerformOAuth(ctx, setup, service)
		if err != nil {
			return nil, err
		}
		email, err := FetchUserEmail(ctx, setup.Fetch, tokens.AccessToken)
		if err != nil {
			return nil, err
		}
		setup.Log(fmt.Sprintf("  Done (%s)", email))
		out := keys.Merge(creds, tokens)
		out["email"] = email
		return out, nil
	}
}

// Setup is the Bun profile.setup of the Camel products that ask nothing
// before the OAuth flow (gdocs, gsheets, gslides, gscript): service is both
// the Scopes key and the CLI noun, displayName the product name Bun logs.
func Setup(service, displayName string) func(context.Context, plugins.SetupOptions, *plugins.SetupContext) (*plugins.SetupResult, error) {
	return func(ctx context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
		setup.Log("Starting OAuth flow for " + displayName + "...\n")
		tokens, err := PerformOAuth(ctx, setup, service)
		if err != nil {
			return nil, err
		}
		email, err := FetchUserEmail(ctx, setup.Fetch, tokens.AccessToken)
		if err != nil {
			return nil, setup.Fail("AUTH_FAILED", "Failed to fetch user email: "+err.Error(), "Ensure the account has an email address")
		}
		creds := Camel.Merge(nil, tokens)
		creds["email"] = email
		return &plugins.SetupResult{
			Credentials:          creds,
			SuggestedProfileName: email,
			Info:                 "Email: " + email + "\nTest with: agentio " + service + " list",
		}, nil
	}
}

func expiryMs(tok *oauth2.Token) int64 {
	if tok.Expiry.IsZero() {
		return 0
	}
	return tok.Expiry.UnixMilli()
}

func scopeOf(tok *oauth2.Token) string {
	s, _ := tok.Extra("scope").(string)
	return s
}

func orBearer(tokenType string) string {
	if tokenType == "" {
		return "Bearer"
	}
	return tokenType
}

// tokenError gives a token endpoint failure the message google-auth-library
// throws: the OAuth error code (invalid_grant), or the whole response when
// Google asks for a ReAuth.
func tokenError(err error) error {
	var re *oauth2.RetrieveError
	if !errors.As(err, &re) || re.Response == nil {
		return err
	}
	message := gaxiosMessage(re.Response.StatusCode, re.Body)
	if message == "invalid_grant" && strings.Contains(strings.ToLower(re.ErrorDescription), "reauth") {
		var compact bytes.Buffer
		if json.Compact(&compact, re.Body) == nil {
			message = compact.String()
		}
	}
	return errors.New(message)
}
