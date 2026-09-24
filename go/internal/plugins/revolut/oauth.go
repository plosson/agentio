package revolut

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

var consentBase = map[string]string{
	"production": "https://business.revolut.com/app-confirm",
	"sandbox":    "https://sandbox-business.revolut.com/app-confirm",
}

const (
	jwtAudience         = "https://revolut.com"
	clientAssertionType = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
	assertionTTLSec     = 60 * 60
)

// specialScheme is the WHATWG set whose URLs must name a host.
var specialScheme = map[string]bool{"http": true, "https": true, "ws": true, "wss": true, "ftp": true}

// issuerFromRedirectURI is the JWT `iss` claim: Revolut derives it from the
// host of the registered redirect URI, not the full URI.
func issuerFromRedirectURI(redirectURI string) (string, error) {
	u, err := url.Parse(redirectURI)
	if err != nil || u.Scheme == "" || specialScheme[strings.ToLower(u.Scheme)] && u.Host == "" {
		return "", &apiError{
			code:       "INVALID_PARAMS",
			message:    fmt.Sprintf(`Redirect URI "%s" is not a valid URL`, redirectURI),
			suggestion: "Use the full URI registered with Revolut, e.g. https://example.com/callback",
		}
	}
	// WHATWG URL#hostname keeps IPv6 brackets and lower-cases the host.
	host := u.Host
	if i := strings.LastIndex(host, ":"); i >= 0 && !strings.HasSuffix(host, "]") {
		host = host[:i]
	}
	return strings.ToLower(host), nil
}

// signingKey is the first private key in a PEM file, as OpenSSL finds it
// (a certificate may come first in the same file).
func signingKey(pemText string) (crypto.Signer, error) {
	rest := []byte(pemText)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return nil, errors.New("error:0900006e:PEM routines:OPENSSL_internal:NO_START_LINE")
		}
		var key any
		var err error
		switch block.Type {
		case "RSA PRIVATE KEY":
			key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
		case "PRIVATE KEY":
			key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		case "EC PRIVATE KEY":
			key, err = x509.ParseECPrivateKey(block.Bytes)
		default:
			continue
		}
		if err != nil {
			return nil, err
		}
		switch k := key.(type) {
		case *rsa.PrivateKey:
			return k, nil
		case *ecdsa.PrivateKey:
			return k, nil
		}
		return nil, errors.New("unsupported private key type")
	}
}

func base64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// createClientAssertion is the RS256 JWT that authenticates the client on
// every token request, signed with the key whose certificate is uploaded to
// Revolut. Header and payload are JSON.stringify of Bun's object literals.
func createClientAssertion(clientID any, privateKey, redirectURI string) (string, error) {
	issuer, err := issuerFromRedirectURI(redirectURI)
	if err != nil {
		return "", err
	}
	header := jsvalue.NewObject()
	header.Set("alg", "RS256")
	header.Set("typ", "JWT")
	payload := jsvalue.NewObject()
	payload.Set("iss", issuer)
	put(payload, "sub", clientID)
	payload.Set("aud", jwtAudience)
	payload.Set("exp", time.Now().Unix()+assertionTTLSec)

	signingInput := base64url(jsvalue.Stringify(header)) + "." + base64url(jsvalue.Stringify(payload))
	signature, err := sign(privateKey, signingInput)
	if err != nil {
		return "", &apiError{
			code:       "AUTH_FAILED",
			message:    "Failed to sign the client assertion: " + err.Error(),
			suggestion: "Check the stored private key is a valid PEM matching the certificate uploaded to Revolut",
		}
	}
	return signingInput + "." + base64url(signature), nil
}

// sign is createSign('RSA-SHA256').sign(pem): PKCS#1 v1.5 for an RSA key, and
// like Node a DER ECDSA signature for an EC key.
func sign(pemText, input string) ([]byte, error) {
	key, err := signingKey(pemText)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte(input))
	return key.Sign(rand.Reader, digest[:], crypto.SHA256)
}

// buildConsentURL is the page where the user approves the app.
func buildConsentURL(environment any, clientID, redirectURI string) (string, error) {
	env, _ := environment.(string)
	base, ok := consentBase[env]
	if !ok {
		return "", errors.New("Invalid URL")
	}
	q := jsvalue.NewSearchParams()
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	return base + "?" + q.String(), nil
}

// extractAuthorizationCode accepts a bare code or the full redirect URL the
// browser landed on.
func extractAuthorizationCode(input string) (string, error) {
	trimmed := jsvalue.Trim(input)
	if strings.HasPrefix(trimmed, "http://") || strings.HasPrefix(trimmed, "https://") {
		parsed, err := url.Parse(trimmed)
		if err != nil {
			return "", &apiError{code: "INVALID_PARAMS", message: "Could not parse the pasted redirect URL"}
		}
		query := parsed.Query()
		if e := query.Get("error"); e != "" {
			return "", &apiError{code: "AUTH_FAILED", message: "Revolut denied the authorisation: " + e}
		}
		code := query.Get("code")
		if code == "" {
			return "", &apiError{
				code:       "INVALID_PARAMS",
				message:    `No "code" parameter found in the pasted redirect URL`,
				suggestion: "Copy the full URL from the browser address bar after approving access",
			}
		}
		return code, nil
	}
	if trimmed == "" {
		return "", &apiError{code: "INVALID_PARAMS", message: "Authorisation code is required"}
	}
	return trimmed, nil
}

// clientConfig is the part of the credentials every token request needs.
type clientConfig struct {
	environment any
	clientID    any
	privateKey  string
	redirectURI string
}

func configOf(creds map[string]any) clientConfig {
	return clientConfig{
		environment: credential(creds, "environment"),
		clientID:    credential(creds, "clientId"),
		privateKey:  text(credential(creds, "privateKey")),
		redirectURI: text(credential(creds, "redirectUri")),
	}
}

func postTokenRequest(ctx context.Context, do fetchFunc, environment any, body *jsvalue.SearchParams) (any, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBaseURL(environment)+"/auth/token", strings.NewReader(body.String()))
	var resp *http.Response
	if err == nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Accept", "application/json")
		resp, err = do(ctx, req)
	}
	if err != nil {
		return nil, &apiError{code: "NETWORK_ERROR", message: "Could not reach the Revolut token endpoint: " + err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	text := jsvalue.DecodeUTF8(raw)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		suggestion := ""
		if resp.StatusCode == 401 {
			suggestion = "Check the client ID, the private key, and that the JWT issuer matches your registered redirect URI host"
		}
		return nil, &apiError{
			code:       plugins.HTTPStatusToErrorCode(resp.StatusCode),
			message:    fmt.Sprintf("Revolut token request failed (%d): %s", resp.StatusCode, text),
			suggestion: suggestion,
		}
	}
	data, err := jsvalue.Parse([]byte(text))
	if err != nil {
		return nil, &apiError{code: "API_ERROR", message: "Revolut returned an unexpected token response: " + text}
	}
	return data, nil
}

func tokenForm(grantType, key, value string, cfg clientConfig) (*jsvalue.SearchParams, error) {
	assertion, err := createClientAssertion(cfg.clientID, cfg.privateKey, cfg.redirectURI)
	if err != nil {
		return nil, err
	}
	q := jsvalue.NewSearchParams()
	q.Set("grant_type", grantType)
	q.Set(key, value)
	q.Set("client_id", text(cfg.clientID))
	q.Set("client_assertion_type", clientAssertionType)
	q.Set("client_assertion", assertion)
	return q, nil
}

type tokens struct {
	accessToken, refreshToken, expiresIn any
}

// exchangeCodeForTokens trades a single-use authorisation code for tokens.
func exchangeCodeForTokens(ctx context.Context, do fetchFunc, code string, cfg clientConfig) (tokens, error) {
	form, err := tokenForm("authorization_code", "code", code, cfg)
	if err != nil {
		return tokens{}, err
	}
	data, err := postTokenRequest(ctx, do, cfg.environment, form)
	if err != nil {
		return tokens{}, err
	}
	if !truthy(field(data, "refresh_token")) {
		return tokens{}, &apiError{
			code:       "AUTH_FAILED",
			message:    "Revolut did not return a refresh token",
			suggestion: "Authorisation codes are single-use and expire within two minutes - request a fresh one",
		}
	}
	return tokens{accessToken: field(data, "access_token"), refreshToken: field(data, "refresh_token"), expiresIn: field(data, "expires_in")}, nil
}

// refreshRevolutToken mints a new access token. Revolut does not rotate
// refresh tokens, so the caller keeps the existing one.
func refreshRevolutToken(ctx context.Context, do fetchFunc, creds map[string]any) (tokens, error) {
	form, err := tokenForm("refresh_token", "refresh_token", text(credential(creds, "refreshToken")), configOf(creds))
	if err != nil {
		return tokens{}, err
	}
	data, err := postTokenRequest(ctx, do, credential(creds, "environment"), form)
	if err != nil {
		return tokens{}, err
	}
	return tokens{accessToken: field(data, "access_token"), expiresIn: field(data, "expires_in")}, nil
}

// withTokens is `{ ...credentials, accessToken, [refreshToken,] expiryDate }`;
// an undefined value drops the key, as JSON.stringify does when Bun stores it.
func withTokens(creds map[string]any, t tokens, keepRefresh bool, nowMs int64) map[string]any {
	out := make(map[string]any, len(creds)+3)
	for k, v := range creds {
		out[k] = v
	}
	set := func(key string, v any) {
		if v == undefined {
			delete(out, key)
		} else {
			out[key] = v
		}
	}
	set("accessToken", t.accessToken)
	if !keepRefresh {
		set("refreshToken", t.refreshToken)
	}
	out["expiryDate"] = jsNumber(float64(nowMs) + num(t.expiresIn)*1000)
	return out
}
