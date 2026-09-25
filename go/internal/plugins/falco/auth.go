package falco

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"golang.org/x/text/unicode/norm"
)

// jsNum is a credential number written as JSON.stringify writes it. A string
// would change the vault wire format the Bun CLI reads back.
type jsNum float64

func (n jsNum) MarshalJSON() ([]byte, error) {
	return jsvalue.Stringify(float64(n)), nil
}

// toNumber is JavaScript's numeric coercion of a stored or decoded value.
func toNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		return jsvalue.Number(t)
	case jsNum:
		return float64(t)
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	default:
		if s, ok := v.(fmt.Stringer); ok {
			f, err := strconv.ParseFloat(s.String(), 64)
			if err == nil {
				return f
			}
		}
		return math.NaN()
	}
}

// tokens is FalcoTokens. Values are kept as decoded so they persist unchanged.
type tokens struct {
	accessToken, refreshToken        any
	expiresIn, refreshTokenExpiresIn float64
}

// requireTokens accepts a token payload only when every field we persist is
// present. Storing an undefined refresh token disables refresh silently.
func requireTokens(raw any) (tokens, error) {
	o, _ := raw.(*jsvalue.Object)
	var missing []string
	for _, field := range []string{"access_token", "refresh_token", "expires_in", "refresh_token_expires_in"} {
		if v, _ := o.Get(field); v == nil {
			missing = append(missing, field)
		}
	}
	if len(missing) > 0 {
		return tokens{}, &apiError{
			code:       "API_ERROR",
			message:    fmt.Sprintf("Falco returned an incomplete token response (missing %s)", strings.Join(missing, ", ")),
			suggestion: "Retry; if it persists the auth API has changed",
		}
	}
	return tokens{
		accessToken:           valueOf(o, "access_token"),
		refreshToken:          valueOf(o, "refresh_token"),
		expiresIn:             toNumber(valueOf(o, "expires_in")),
		refreshTokenExpiresIn: toNumber(valueOf(o, "refresh_token_expires_in")),
	}, nil
}

// applyTokens is the `{ ...credentials, accessToken, expiryDate, refreshToken,
// refreshExpiryDate }` spread shared by refresh and reauthentication.
func applyTokens(creds map[string]any, t tokens, nowMs int64) map[string]any {
	out := make(map[string]any, len(creds)+4)
	for k, v := range creds {
		out[k] = v
	}
	now := float64(nowMs)
	out["accessToken"] = t.accessToken
	out["expiryDate"] = jsNum(now + t.expiresIn*1000)
	// Falco rotates the refresh token on every exchange; losing this write
	// loses the session.
	out["refreshToken"] = t.refreshToken
	out["refreshExpiryDate"] = jsNum(now + t.refreshTokenExpiresIn*1000)
	return out
}

type loginResult struct {
	twoFactorRequired bool
	tokens            tokens
}

func networkError(err error) error {
	return &apiError{code: "NETWORK_ERROR", message: "Could not reach Falco: " + err.Error()}
}

// login is loginToFalco: password login, optionally with a 2FA code. Falco
// reports a missing second factor as an error body rather than a status.
func login(ctx context.Context, do fetchFunc, username, password string, twoFaCode *string) (loginResult, error) {
	body := jsvalue.NewObject()
	body.Set("userName", username)
	body.Set("password", password)
	if twoFaCode != nil {
		body.Set("twoFaCode", *twoFaCode)
	} else {
		body.Set("twoFaCode", nil)
	}
	body.Set("brand", brand)
	body.Set("impersonate", nil)
	scopes := make([]any, len(loginScopes))
	for i, s := range loginScopes {
		scopes[i] = s
	}
	body.Set("scopes", scopes)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL+"/login", bytes.NewReader(jsvalue.Stringify(body)))
	if err != nil {
		return loginResult{}, networkError(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := do(ctx, req)
	if err != nil {
		return loginResult{}, networkError(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return loginResult{}, err
	}
	text := jsvalue.DecodeUTF8(raw)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// Never echo this body: on success it is the token payload itself.
		parsed, err := jsvalue.Parse([]byte(text))
		if err != nil || parsed == nil {
			return loginResult{}, &apiError{
				code:       "API_ERROR",
				message:    "Falco returned a login response that could not be read",
				suggestion: "Retry; if it persists the login API has changed",
			}
		}
		t, err := requireTokens(parsed)
		if err != nil {
			return loginResult{}, err
		}
		return loginResult{tokens: t}, nil
	}

	parsed, _ := jsvalue.Parse([]byte(text))
	o, _ := parsed.(*jsvalue.Object)
	code, _ := o.Str("error")
	switch code {
	case "two_factor_required":
		return loginResult{twoFactorRequired: true}, nil
	case "invalid_credentials":
		return loginResult{}, &apiError{code: "AUTH_FAILED", message: "Invalid Falco credentials", suggestion: "Check the email and password"}
	case "invalid_two_factor_code":
		return loginResult{}, &apiError{
			code:       "AUTH_FAILED",
			message:    "Falco rejected the two-factor code",
			suggestion: "Codes expire quickly. Re-run the command and enter a fresh one.",
		}
	}
	return loginResult{}, &apiError{code: "AUTH_FAILED", message: fmt.Sprintf("Falco login failed (HTTP %d): %s", resp.StatusCode, jsvalue.Slice(text, 200))}
}

// refreshToken is refreshFalcoToken. The token rotates, so the result must be
// persisted. The scope list is narrower than login's, as the desktop app sends.
func refreshToken(ctx context.Context, do fetchFunc, token string) (tokens, error) {
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	_ = form.WriteField("grant_type", "refresh_token")
	_ = form.WriteField("scope", strings.Join(refreshScopes, " "))
	_ = form.WriteField("refresh_token", token)
	_ = form.Close()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL+"/oauth2/token", &buf)
	if err != nil {
		return tokens{}, networkError(err)
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	resp, err := do(ctx, req)
	if err != nil {
		return tokens{}, networkError(err)
	}
	defer resp.Body.Close()
	// Bun reads an error body with .catch(() => ""), a success one with json().
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		raw = nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return tokens{}, &apiError{
			code:       "TOKEN_EXPIRED",
			message:    fmt.Sprintf("Falco refresh failed (HTTP %d): %s", resp.StatusCode, jsvalue.Slice(jsvalue.DecodeUTF8(raw), 200)),
			suggestion: "Run: agentio reauth",
		}
	}
	if err != nil {
		return tokens{}, err
	}
	parsed, err := jsvalue.Parse([]byte(jsvalue.DecodeUTF8(raw)))
	if err != nil {
		return tokens{}, fmt.Errorf("JSON Parse error: Unable to parse JSON string")
	}
	return requireTokens(parsed)
}

// revoke is best-effort; Falco does not report a useful failure here. It runs
// when reauthentication supersedes a token, not when a profile is removed.
func revoke(ctx context.Context, do fetchFunc, token any) {
	body := jsvalue.NewObject()
	body.Set("RefreshToken", token)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, authURL+"/revoke-refresh-token", bytes.NewReader(jsvalue.Stringify(body)))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if resp, err := do(ctx, req); err == nil {
		resp.Body.Close()
	}
}

// --- credential lifecycle -------------------------------------------------------

func applies(creds map[string]any) bool {
	return jsvalue.Truthy(creds["refreshToken"])
}

// stale is `expiryDate === undefined || now + bufferMs >= expiryDate`. Falco
// access tokens live well under an hour, and a missing expiry means one was
// never exchanged.
func stale(creds map[string]any, nowMs, bufferMs int64) bool {
	raw, present := creds["expiryDate"]
	if !present {
		return true
	}
	return float64(nowMs+bufferMs) >= toNumber(raw)
}

func refresh(ctx context.Context, creds map[string]any) (map[string]any, error) {
	if raw, present := creds["refreshExpiryDate"]; present && float64(time.Now().UnixMilli()) >= toNumber(raw) {
		return nil, &apiError{code: "TOKEN_EXPIRED", message: "The Falco refresh token has expired", suggestion: "Run: agentio reauth"}
	}
	t, err := refreshToken(ctx, plugins.Fetch, jsvalue.String(orNull(creds["refreshToken"])))
	if err != nil {
		return nil, err
	}
	return applyTokens(creds, t, time.Now().UnixMilli()), nil
}

// --- profile add and reauthentication -------------------------------------------

// promptText is Bun's inquirer input: the answer is trimmed and a closed stdin
// reads as empty.
func promptText(setup *plugins.SetupContext, question string) string {
	answer, _ := setup.Prompt(question, false)
	return jsvalue.Trim(answer)
}

func promptPassword(setup *plugins.SetupContext, question string) string {
	answer, _ := setup.Prompt(question, true)
	return answer
}

// promptChoice is inquirer's select. One option needs no question, which
// keeps a single-organization login non-interactive past the password.
func promptChoice(setup *plugins.SetupContext, message string, names []string) (int, error) {
	if len(names) == 1 {
		return 0, nil
	}
	choices := make([]plugins.Choice, len(names))
	for i, name := range names {
		choices[i] = plugins.Choice{Name: name}
	}
	return setup.Select(message, choices)
}

// loginInteractively runs the password and optional second-factor exchange.
func loginInteractively(ctx context.Context, setup *plugins.SetupContext, email, password, codePrompt string) (tokens, error) {
	result, err := login(ctx, setup.Fetch, email, password, nil)
	if err != nil {
		return tokens{}, failed(setup.Fail, err)
	}
	if result.twoFactorRequired {
		code := promptText(setup, codePrompt)
		if code == "" {
			return tokens{}, setup.Fail("INVALID_PARAMS", "A two-factor code is required", "")
		}
		result, err = login(ctx, setup.Fetch, email, password, &code)
		if err != nil {
			return tokens{}, failed(setup.Fail, err)
		}
	}
	if result.twoFactorRequired {
		// Reached only when Falco asks for a second factor again after one was
		// entered, so do not claim the user supplied nothing.
		return tokens{}, setup.Fail("AUTH_FAILED", "Falco is still asking for a two-factor code", "Re-run the command and enter a fresh code.")
	}
	return result.tokens, nil
}

// setup is falcoProfileAdd. Falco authenticates with email and password, so
// this is an interactive flow rather than an OAuth redirect. The organization
// is picked once and stored, because every data endpoint is org-scoped.
func setup(ctx context.Context, _ plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("\nFalco Setup\n")
	email := promptText(setup, "? Email: ")
	if email == "" {
		return nil, setup.Fail("INVALID_PARAMS", "An email address is required", "")
	}
	password := promptPassword(setup, "? Password: ")
	if password == "" {
		return nil, setup.Fail("INVALID_PARAMS", "A password is required", "")
	}
	t, err := loginInteractively(ctx, setup, email, password, "? Two-factor code: ")
	if err != nil {
		return nil, err
	}

	now := time.Now().UnixMilli()
	// A client scoped to no organization can still read /user/me, which is
	// what supplies the organization list.
	bootstrap := applyTokens(map[string]any{"organizationId": "", "userId": "", "userEmail": email}, t, now)
	me, err := newClient(ctx, bootstrap, setup.Fetch).getUserMe()
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	if len(me.organizations) == 0 {
		return nil, setup.Fail("CONFIG_ERROR", "This Falco account has no organizations", "")
	}
	names := make([]string, len(me.organizations))
	for i, org := range me.organizations {
		names[i] = org.name
		if org.vatNumber != nil && *org.vatNumber != "" {
			names[i] += " — " + *org.vatNumber
		}
	}
	choice, err := promptChoice(setup, "Organization", names)
	if err != nil {
		return nil, err
	}
	org := me.organizations[choice]

	creds := applyTokens(map[string]any{}, t, now)
	creds["organizationId"] = org.id
	creds["organizationName"] = org.name
	putIfPresent(creds, "userId", me.raw, "id")
	putIfPresent(creds, "userEmail", me.raw, "email")
	return &plugins.SetupResult{
		Credentials:          creds,
		SuggestedProfileName: slugifyOrganization(org.name),
		Info:                 fmt.Sprintf("%s %s <%s>\nOrganization: %s (%s)", me.firstName, me.lastName, me.email, org.name, org.id),
	}, nil
}

// putIfPresent copies a field the way an object literal does: JSON.stringify
// drops an undefined value, so an absent field is not stored.
func putIfPresent(dst map[string]any, key string, src *jsvalue.Object, field string) {
	if v, ok := src.Get(field); ok {
		dst[key] = v
	}
}

var (
	nonSlug     = regexp.MustCompile(`[^a-z0-9]+`)
	edgeDashes  = regexp.MustCompile(`^-+|-+$`)
	trailDashes = regexp.MustCompile(`-+$`)
)

// stripMarks removes U+0300-U+036F after NFD, as `.replace(/[̀-ͯ]/g, ”)`.
func stripMarks(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0x300 && r <= 0x36f {
			return -1
		}
		return r
	}, norm.NFD.String(s))
}

// slugifyOrganization is "Acme BV" -> "acme-bv"; "falco" when nothing usable remains.
func slugifyOrganization(name string) string {
	slug := stripMarks(strings.ToLower(name))
	slug = nonSlug.ReplaceAllString(slug, "-")
	slug = edgeDashes.ReplaceAllString(slug, "")
	slug = jsvalue.Slice(slug, 64)
	slug = trailDashes.ReplaceAllString(slug, "")
	if slug == "" {
		return "falco"
	}
	return slug
}

// reauth is reauthenticateFalco. The organization is already known, so this
// asks only for the password (and a 2FA code when Falco wants one) and keeps
// everything else about the profile as it was.
func reauth(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
	if creds == nil {
		return nil, setup.Fail("AUTH_FAILED",
			fmt.Sprintf("Profile \"%s\" has no stored Falco credentials", profileName),
			"Run: agentio falco profile add --profile "+profileName)
	}
	email := jsvalue.String(orNull(creds["userEmail"]))
	setup.Log(fmt.Sprintf("\nRe-authenticating falco / %s (%s)", profileName, email))
	password := promptPassword(setup, "? Password: ")
	if password == "" {
		return nil, setup.Fail("AUTH_FAILED", "A password is required", "")
	}
	t, err := loginInteractively(ctx, setup, email, password, "? Two-factor code: ")
	if err != nil {
		return nil, err
	}
	replacement := applyTokens(creds, t, time.Now().UnixMilli())

	c := newClient(ctx, replacement, setup.Fetch)
	validation := c.validate()
	if !validation.Valid {
		// Covers a revoked membership as well as bad credentials.
		return nil, setup.Fail("AUTH_FAILED", "Could not use this profile: "+validation.Error, "")
	}
	// Pick up a renamed organization rather than keeping a stale label.
	me, err := c.getUserMe()
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	for _, org := range me.organizations {
		if org.id == c.organizationID {
			replacement["organizationName"] = org.name
			break
		}
	}
	// The replacement works, so the superseded token is orphaned. Revoked only
	// after validation, so a failed reauth leaves the old one usable.
	revoke(ctx, setup.Fetch, creds["refreshToken"])
	setup.Log(fmt.Sprintf("  Done (%s)", validation.Info))
	return replacement, nil
}

// listInfo is getExtraInfo: " - <email> (<organization name or id>)".
func listInfo(creds map[string]any) string {
	if creds == nil {
		return ""
	}
	org := creds["organizationName"]
	if org == nil {
		org = orNull(creds["organizationId"])
	}
	return fmt.Sprintf(" - %s (%s)", jsvalue.String(orNull(creds["userEmail"])), jsvalue.String(org))
}
