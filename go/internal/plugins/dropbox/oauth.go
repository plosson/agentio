package dropbox

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

const (
	authorizeURL = "https://www.dropbox.com/oauth2/authorize"
	tokenURL     = "https://api.dropboxapi.com/oauth2/token"
)

// dropboxScopes must also be enabled on the app's Permissions tab in the
// Dropbox App Console, otherwise Dropbox rejects the authorisation URL.
var dropboxScopes = []string{
	"account_info.read",
	"files.metadata.read",
	"files.content.read",
	"files.content.write",
	"sharing.read",
	"sharing.write",
}

func defaultFetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	return http.DefaultClient.Do(req.WithContext(ctx))
}

// pkcePair is createPkcePair: a base64url verifier of 64 random bytes and its
// S256 challenge.
func pkcePair() (verifier, challenge string, err error) {
	buf := make([]byte, 64)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	verifier = base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// formEncode is URLSearchParams.toString(): pairs in insertion order.
func formEncode(pairs ...string) string {
	parts := make([]string, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		parts = append(parts, url.QueryEscape(pairs[i])+"="+url.QueryEscape(pairs[i+1]))
	}
	return strings.Join(parts, "&")
}

// buildAuthorizeURL has no redirect URI on purpose: Dropbox then shows the
// code in the browser, so the app needs no registered redirect and no listener.
func buildAuthorizeURL(appKey, challenge string) string {
	return authorizeURL + "?" + formEncode(
		"client_id", appKey,
		"response_type", "code",
		"token_access_type", "offline",
		"code_challenge", challenge,
		"code_challenge_method", "S256",
		"scope", strings.Join(dropboxScopes, " "),
	)
}

type tokenResponse struct {
	AccessToken  *string  `json:"access_token"`
	RefreshToken string   `json:"refresh_token"`
	ExpiresIn    *float64 `json:"expires_in"`
	AccountID    string   `json:"account_id"`
}

func postTokenRequest(ctx context.Context, do fetchFunc, form string) (tokenResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form))
	if err != nil {
		return tokenResponse{}, &apiError{code: "NETWORK_ERROR", message: "Could not reach the Dropbox token endpoint: " + err.Error()}
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := do(ctx, req)
	if err != nil {
		return tokenResponse{}, &apiError{code: "NETWORK_ERROR", message: "Could not reach the Dropbox token endpoint: " + err.Error()}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return tokenResponse{}, err
	}
	text := string(raw)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		suggestion := ""
		if resp.StatusCode == http.StatusBadRequest {
			suggestion = "Authorisation codes are single-use and short-lived - request a fresh one"
		}
		return tokenResponse{}, &apiError{
			code:       statusCode(resp.StatusCode),
			message:    fmt.Sprintf("Dropbox token request failed (%d): %s", resp.StatusCode, text),
			suggestion: suggestion,
		}
	}
	var parsed tokenResponse
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return tokenResponse{}, &apiError{code: "API_ERROR", message: "Dropbox returned an unexpected token response: " + text}
	}
	return parsed, nil
}

func exchangeCode(ctx context.Context, do fetchFunc, code, appKey, verifier string) (tokenResponse, error) {
	data, err := postTokenRequest(ctx, do, formEncode(
		"grant_type", "authorization_code",
		"code", code,
		"client_id", appKey,
		"code_verifier", verifier,
	))
	if err != nil {
		return tokenResponse{}, err
	}
	if data.RefreshToken == "" {
		return tokenResponse{}, &apiError{
			code:       "AUTH_FAILED",
			message:    "Dropbox did not return a refresh token",
			suggestion: "The authorisation URL must include token_access_type=offline - retry: agentio dropbox profile add",
		}
	}
	return data, nil
}

// setTokens writes the access token and expiry the way Bun spreads them: a
// missing access_token drops the key, a missing expires_in is NaN, stored as null.
func setTokens(creds map[string]any, data tokenResponse) {
	if data.AccessToken != nil {
		creds["accessToken"] = *data.AccessToken
	} else {
		delete(creds, "accessToken")
	}
	if data.ExpiresIn != nil {
		creds["expiryDate"] = jsonNum(time.Now().UnixMilli() + int64(*data.ExpiresIn*1000))
	} else {
		creds["expiryDate"] = nil
	}
}

// ask is Bun's prompt(): the answer is trimmed and a closed stdin reads as empty.
func ask(setup *plugins.SetupContext, question string) string {
	answer, _ := setup.Prompt(question, false)
	return jsvalue.Trim(answer)
}

// authorise shows the authorisation URL and reads back the pasted code.
func authorise(setup *plugins.SetupContext, appKey string, show func(authURL string)) (code, verifier string, err error) {
	verifier, challenge, err := pkcePair()
	if err != nil {
		return "", "", err
	}
	authURL := buildAuthorizeURL(appKey, challenge)
	show(authURL)
	setup.OpenURL(authURL)
	code = ask(setup, "? Paste the authorisation code: ")
	if code == "" {
		return "", "", setup.Fail("INVALID_PARAMS", "Authorisation code is required", "")
	}
	return code, verifier, nil
}

func setup(ctx context.Context, opts plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("\nDropbox Setup\n")
	setup.Log("Prerequisite: create an app at https://www.dropbox.com/developers/apps")
	setup.Log(`  1. Choose "Scoped access" and "Full Dropbox"`)
	setup.Log("  2. On the Permissions tab enable: account_info.read, files.metadata.read,")
	setup.Log("     files.content.read, files.content.write, sharing.read, sharing.write")
	setup.Log("  3. Copy the App key from the Settings tab\n")
	setup.Log("No redirect URI is needed - Dropbox shows the code in the browser.\n")

	appKey := opts.Option("app-key")
	if appKey == "" {
		appKey, _ = setup.Prompt("? App key: ", false)
	}
	appKey = jsvalue.Trim(appKey)
	if appKey == "" {
		return nil, setup.Fail("INVALID_PARAMS", "App key is required", "")
	}

	code, verifier, err := authorise(setup, appKey, func(authURL string) {
		setup.Log("\nAuthorise the app in your browser:")
		setup.Log(fmt.Sprintf("  %s\n", authURL))
		setup.Log("After approving, Dropbox displays an authorisation code to copy.\n")
	})
	if err != nil {
		return nil, err
	}
	setup.Log("\nExchanging the authorisation code...")
	tokens, err := exchangeCode(ctx, setup.Fetch, code, appKey, verifier)
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	creds := map[string]any{"appKey": appKey, "refreshToken": tokens.RefreshToken}
	setTokens(creds, tokens)
	if tokens.AccountID != "" {
		creds["accountId"] = tokens.AccountID
	}

	setup.Log("Validating access...")
	acct, err := newAPI(ctx, creds, setup.Fetch).account()
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	creds["email"] = acct.Email
	creds["name"] = acct.Name
	creds["accountId"] = acct.AccountID
	return &plugins.SetupResult{
		Credentials:          creds,
		SuggestedProfileName: acct.Email,
		Info:                 fmt.Sprintf("Account: %s <%s>\nTest with: agentio dropbox list", acct.Name, acct.Email),
	}, nil
}

func reauth(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
	appKey := str(creds, "appKey")
	if appKey == "" {
		return nil, setup.Fail("AUTH_FAILED", "Dropbox app key is missing", "")
	}
	setup.Log(fmt.Sprintf("\nRe-authenticating dropbox / %s...", profileName))
	code, verifier, err := authorise(setup, appKey, func(authURL string) {
		setup.Log(fmt.Sprintf("  %s\n", authURL))
	})
	if err != nil {
		return nil, err
	}
	tokens, err := exchangeCode(ctx, setup.Fetch, code, appKey, verifier)
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	out := copyMap(creds)
	setTokens(out, tokens)
	out["refreshToken"] = tokens.RefreshToken
	if tokens.AccountID != "" {
		out["accountId"] = tokens.AccountID
	}
	acct, err := newAPI(ctx, out, setup.Fetch).account()
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	setup.Log(fmt.Sprintf("  Done (%s)", acct.Email))
	out["accountId"] = acct.AccountID
	out["email"] = acct.Email
	out["name"] = acct.Name
	return out, nil
}

func applies(creds map[string]any) bool {
	return truthy(creds["refreshToken"])
}

// stale is Bun's `expiryDate === undefined || now + bufferMs >= expiryDate`.
// A missing expiry is stale; a stored null coerces to 0, so it is stale too.
func stale(creds map[string]any, nowMs, bufferMs int64) bool {
	raw, present := creds["expiryDate"]
	if !present || raw == nil {
		return true
	}
	expiry, ok := asInt64(raw)
	if !ok {
		return false
	}
	return nowMs+bufferMs >= expiry
}

// refresh keeps the refresh token: Dropbox does not rotate it.
func refresh(ctx context.Context, creds map[string]any) (map[string]any, error) {
	data, err := postTokenRequest(ctx, defaultFetch, formEncode(
		"grant_type", "refresh_token",
		"refresh_token", str(creds, "refreshToken"),
		"client_id", str(creds, "appKey"),
	))
	if err != nil {
		return nil, err
	}
	out := copyMap(creds)
	setTokens(out, data)
	return out, nil
}
