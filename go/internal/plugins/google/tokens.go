package google

import (
	"context"
	"encoding/json"
	"math"
	"strconv"

	"github.com/plosson/agentio/go/internal/plugins"
)

// Keys names the token fields in a product's credential JSON. The names are a
// vault wire format: Bun gmail, gcal and gtasks store Snake, the other Google
// products store Camel.
type Keys struct {
	AccessToken  string
	RefreshToken string
	ExpiryDate   string
	TokenType    string
	Scope        string
	// SecretField is the Bun credentialLifecycle secretFields entry.
	SecretField string
}

var (
	// Snake is Bun OAuthTokens (googleSnakeCredentialLifecycle).
	Snake = Keys{"access_token", "refresh_token", "expiry_date", "token_type", "scope", "refresh_token"}
	// Camel is Bun GoogleCamelTokens (googleCamelCredentialLifecycle).
	Camel = Keys{"accessToken", "refreshToken", "expiryDate", "tokenType", "scope", "refreshToken"}
)

// Tokens is one Google token response. An empty RefreshToken or Scope and a
// zero ExpiryDate are absent (undefined in Bun).
type Tokens struct {
	AccessToken  string
	RefreshToken string
	ExpiryDate   int64
	TokenType    string
	Scope        string
}

// Read returns the token fields stored under k.
func (k Keys) Read(creds map[string]any) Tokens {
	expiry, _ := asInt64(creds[k.ExpiryDate])
	return Tokens{
		AccessToken:  str(creds, k.AccessToken),
		RefreshToken: str(creds, k.RefreshToken),
		ExpiryDate:   expiry,
		TokenType:    str(creds, k.TokenType),
		Scope:        str(creds, k.Scope),
	}
}

// Merge is Bun `{ ...prev, ...tokens }` under k. prev is not modified. An
// absent token field is removed, as a spread undefined is dropped by
// JSON.stringify.
func (k Keys) Merge(prev map[string]any, t Tokens) map[string]any {
	out := make(map[string]any, len(prev)+5)
	for key, v := range prev {
		out[key] = v
	}
	out[k.AccessToken] = t.AccessToken
	setOrDelete(out, k.RefreshToken, t.RefreshToken)
	if t.ExpiryDate != 0 {
		out[k.ExpiryDate] = jsonNum(t.ExpiryDate)
	} else {
		delete(out, k.ExpiryDate)
	}
	setOrDelete(out, k.TokenType, t.TokenType)
	setOrDelete(out, k.Scope, t.Scope)
	return out
}

// RefreshSpec is the Bun credentialLifecycle for k.
func (k Keys) RefreshSpec() *plugins.RefreshSpec {
	return &plugins.RefreshSpec{
		SecretFields: []string{k.SecretField},
		Applies:      k.Applies,
		IsStale:      k.IsStale,
		Run:          k.Refresh,
	}
}

// Applies is Bun `!!credentials.refresh_token` (or refreshToken). A gchat
// webhook profile has none and is left alone.
func (k Keys) Applies(creds map[string]any) bool {
	return str(creds, k.RefreshToken) != ""
}

// IsStale is Bun `expiry !== undefined && now + bufferMs >= expiry`. A stored
// null coerces to 0 in JavaScript, so it counts as expired.
func (k Keys) IsStale(creds map[string]any, nowMs, bufferMs int64) bool {
	raw, present := creds[k.ExpiryDate]
	if !present {
		return false
	}
	if raw == nil {
		return true
	}
	expiry, ok := asInt64(raw)
	return ok && nowMs+bufferMs >= expiry
}

// Refresh is Bun refreshGoogleAccessToken merged over the stored map. It
// returns the replacement and does not persist it.
func (k Keys) Refresh(ctx context.Context, creds map[string]any) (map[string]any, error) {
	next, err := refreshTokens(ctx, k.Read(creds))
	if err != nil {
		return nil, err
	}
	return k.Merge(creds, next), nil
}

// jsonNum is an expiry written as a JSON number. A string would change the
// vault wire format the Bun CLI reads back.
type jsonNum int64

func (n jsonNum) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatInt(int64(n), 10)), nil
}

func setOrDelete(m map[string]any, key, value string) {
	if value == "" {
		delete(m, key)
		return
	}
	m[key] = value
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// asInt64 reads an expiry after a vault round trip (json.Number) or from a
// map that has not been serialized yet.
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return i, true
		}
		f, err := n.Float64()
		if err != nil || math.IsNaN(f) {
			return 0, false
		}
		return int64(f), true
	case jsonNum:
		return int64(n), true
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}
