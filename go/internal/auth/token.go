package auth

import (
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
)

const tokenPrefix = "agio1"

// TokenParts is the composite token an agent machine carries in AGENTIO_TOKEN:
//
//	agio1.<base64url({v,url,kid})>.<secret>
type TokenParts struct {
	URL    string
	Kid    string
	Secret string
}

func EncodeToken(parts TokenParts) (string, error) {
	meta, err := json.Marshal(struct {
		V   int    `json:"v"`
		URL string `json:"url"`
		Kid string `json:"kid"`
	}{1, parts.URL, parts.Kid})
	if err != nil {
		return "", err
	}
	return tokenPrefix + "." + base64.RawURLEncoding.EncodeToString(meta) + "." + parts.Secret, nil
}

func DecodeToken(token string) (TokenParts, error) {
	malformed := clierr.New(clierr.ConfigError, "Malformed AGENTIO_TOKEN", "Paste the token exactly as the hub showed it")
	bits := strings.Split(strings.TrimSpace(token), ".")
	if len(bits) != 3 || bits[0] != tokenPrefix || bits[1] == "" || bits[2] == "" {
		return TokenParts{}, malformed
	}
	raw, err := base64.RawURLEncoding.DecodeString(bits[1])
	if err != nil {
		return TokenParts{}, malformed
	}
	var parsed struct {
		V   any    `json:"v"`
		URL string `json:"url"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return TokenParts{}, malformed
	}
	isOne, ok := numberOne(parsed.V)
	if !ok || !isOne || parsed.URL == "" || parsed.Kid == "" {
		return TokenParts{}, malformed
	}
	return TokenParts{URL: parsed.URL, Kid: parsed.Kid, Secret: bits[2]}, nil
}

func numberOne(v any) (bool, bool) {
	switch n := v.(type) {
	case float64:
		return n == 1, true
	case json.Number:
		i, err := n.Int64()
		return err == nil && i == 1, true
	case int:
		return n == 1, true
	default:
		return false, false
	}
}
