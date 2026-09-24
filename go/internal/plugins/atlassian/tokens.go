package atlassian

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/plosson/agentio/go/internal/plugins"
)

// RefreshSpec is the Bun credentialLifecycle every Atlassian product shares.
func RefreshSpec() *plugins.RefreshSpec {
	return &plugins.RefreshSpec{
		SecretFields: []string{"refreshToken"},
		Applies:      Applies,
		IsStale:      IsStale,
		Run:          Refresh,
	}
}

// Applies is Bun `!!credentials.refreshToken`.
func Applies(creds map[string]any) bool {
	token, ok := creds["refreshToken"].(string)
	return ok && token != ""
}

// IsStale is Bun's `expiryDate !== undefined && now + bufferMs >= expiryDate`.
// A stored null coerces to 0 in JavaScript, so it counts as expired.
func IsStale(creds map[string]any, nowMs, bufferMs int64) bool {
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

// Refresh is Bun refresh<Product>Token merged over the stored map: the new
// access token and expiry, the rotated refresh token or the stored one.
func Refresh(ctx context.Context, creds map[string]any) (map[string]any, error) {
	clientSecret, err := secret()
	if err != nil {
		return nil, err
	}
	old := Str(creds, "refreshToken")
	next, err := requestToken(ctx, defaultFetch, map[string]any{
		"grant_type":    "refresh_token",
		"client_id":     ClientID,
		"client_secret": clientSecret,
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

// ListInfo is the Bun getExtraInfo: " - <siteUrl>" when the profile has one.
func ListInfo(creds map[string]any) string {
	if site := Str(creds, "siteUrl"); site != "" {
		return " - " + site
	}
	return ""
}

// Str is creds[key] when it is a string, else "".
func Str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// jsonNum is a credential expiry written as a JSON number. A plain string
// would change the vault wire format the Bun CLI reads back.
type jsonNum int64

func (n jsonNum) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatInt(int64(n), 10)), nil
}

func copyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// asInt64 reads an expiry after a vault round trip (json.Number) or from a
// map that has not been serialized yet.
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			f, ferr := n.Float64()
			if ferr != nil {
				return 0, false
			}
			return int64(f), true
		}
		return i, true
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
