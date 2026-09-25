package google

import (
	"context"
	"encoding/json"
	"math"
	"strconv"

	"github.com/plosson/agentio/go/internal/jsvalue"
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
func (k Keys) Read(creds plugins.Credentials) Tokens {
	expiry, _ := asInt64(creds.Value(k.ExpiryDate))
	return Tokens{
		AccessToken:  creds.StrValue(k.AccessToken),
		RefreshToken: creds.StrValue(k.RefreshToken),
		ExpiryDate:   expiry,
		TokenType:    creds.StrValue(k.TokenType),
		Scope:        creds.StrValue(k.Scope),
	}
}

// Merge is Bun `{ ...prev, ...tokens }` under k, the order every Google
// setup, refresh and reauth builds: prev's keys where they are, then the
// token fields in the order access, refresh, expiry, type, scope, a new one
// last. An absent field is undefined: it keeps no place, and JSON.stringify
// drops it. prev is not modified; nil is `{}`.
func (k Keys) Merge(prev plugins.Credentials, t Tokens) plugins.Credentials {
	out := jsvalue.Spread(prev)
	out.Set(k.AccessToken, t.AccessToken)
	out.Set(k.RefreshToken, orUndefined(t.RefreshToken))
	if t.ExpiryDate != 0 {
		out.Set(k.ExpiryDate, jsonNum(t.ExpiryDate))
	} else {
		out.Set(k.ExpiryDate, jsvalue.Undefined)
	}
	out.Set(k.TokenType, orUndefined(t.TokenType))
	out.Set(k.Scope, orUndefined(t.Scope))
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
func (k Keys) Applies(creds plugins.Credentials) bool {
	return creds.StrValue(k.RefreshToken) != ""
}

// IsStale is Bun `expiry !== undefined && now + bufferMs >= expiry`. A stored
// null coerces to 0 in JavaScript, so it counts as expired.
func (k Keys) IsStale(creds plugins.Credentials, nowMs, bufferMs int64) bool {
	raw, present := creds.Get(k.ExpiryDate)
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
func (k Keys) Refresh(ctx context.Context, creds plugins.Credentials) (plugins.Credentials, error) {
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

// orUndefined is Bun `value || undefined` for a string field.
func orUndefined(value string) any {
	if value == "" {
		return jsvalue.Undefined
	}
	return value
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
