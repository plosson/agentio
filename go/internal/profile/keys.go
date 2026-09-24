package profile

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/vault"
)

const (
	touchInterval = 60 * time.Second
	maxKeyName    = 64
)

// KeyView is an API key without its secret hash.
type KeyView struct {
	ID                string      `json:"id"`
	Name              string      `json:"name"`
	Hint              string      `json:"hint,omitempty"`
	AllowedProfiles   vault.Scope `json:"allowedProfiles"`
	ReadOnly          bool        `json:"readOnly"`
	CanManageProfiles bool        `json:"canManageProfiles"`
	CreatedAt         string      `json:"createdAt"`
	LastUsedAt        string      `json:"lastUsedAt,omitempty"`
}

func view(k vault.APIKey) KeyView {
	return KeyView{
		ID: k.ID, Name: k.Name, Hint: k.Hint, AllowedProfiles: k.AllowedProfiles,
		ReadOnly: k.ReadOnly, CanManageProfiles: k.Manage(),
		CreatedAt: k.CreatedAt, LastUsedAt: k.LastUsedAt,
	}
}

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func secretMatches(secret, storedHash string) bool {
	a, err1 := hex.DecodeString(hashSecret(secret))
	b, err2 := hex.DecodeString(storedHash)
	if err1 != nil || err2 != nil || len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}

func newSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func hintOf(secret string) string {
	if len(secret) < 4 {
		return secret
	}
	return secret[len(secret)-4:]
}

func newKeyID() string {
	for {
		b := make([]byte, 6)
		_, _ = rand.Read(b)
		id := base64.RawURLEncoding.EncodeToString(b)
		if id[0] != '-' {
			return id
		}
	}
}

func ValidateKeyName(name string) (string, error) {
	trimmed := trimSpace(name)
	if trimmed == "" || len(trimmed) > maxKeyName {
		return "", clierr.New(clierr.InvalidParams, fmt.Sprintf("A key needs a name of 1 to %d characters", maxKeyName), "")
	}
	return trimmed, nil
}

func trimSpace(s string) string {
	i, j := 0, len(s)
	for i < j && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n') {
		i++
	}
	for j > i && (s[j-1] == ' ' || s[j-1] == '\t' || s[j-1] == '\n') {
		j--
	}
	return s[i:j]
}

func ValidateFlag(field string, value any) (bool, error) {
	b, ok := value.(bool)
	if !ok {
		return false, clierr.New(clierr.InvalidParams, field+" must be true or false", "")
	}
	return b, nil
}

func ValidateHubURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		if err != nil || parsed == nil || parsed.Host == "" {
			return "", clierr.New(clierr.InvalidParams, "The hub URL must be absolute, e.g. https://vault.example.com", "")
		}
		return "", clierr.New(clierr.InvalidParams, "The hub URL must use http or https", "")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func DescribeScope(k KeyView) string {
	scope := "no profiles"
	if k.AllowedProfiles.All {
		scope = "all profiles"
	} else if len(k.AllowedProfiles.Refs) > 0 {
		scope = ""
		for i, r := range k.AllowedProfiles.Refs {
			if i > 0 {
				scope += ", "
			}
			scope += r
		}
	}
	if k.ReadOnly {
		scope += ", read-only"
	}
	if k.CanManageProfiles {
		scope += ", can manage profiles"
	}
	return scope
}

type KeyInput struct {
	Name              any
	AllowedProfiles   any
	ReadOnly          any
	CanManageProfiles any
}

type IssuedKey struct {
	Key   KeyView `json:"key"`
	Token string  `json:"token"`
}

func ListKeys() ([]KeyView, error) {
	c, err := vault.Load()
	if err != nil {
		return nil, err
	}
	out := make([]KeyView, 0, len(c.Config.APIKeys))
	for _, k := range c.Config.APIKeys {
		out = append(out, view(k))
	}
	return out, nil
}

func CreateKey(input KeyInput, hubURL string) (IssuedKey, error) {
	name, err := ValidateKeyName(fmt.Sprint(input.Name))
	if err != nil {
		return IssuedKey{}, err
	}
	// fmt.Sprint(nil) is "<nil>". Require a real string.
	if _, ok := input.Name.(string); !ok {
		return IssuedKey{}, clierr.New(clierr.InvalidParams, fmt.Sprintf("A key needs a name of 1 to %d characters", maxKeyName), "")
	}
	name, err = ValidateKeyName(input.Name.(string))
	if err != nil {
		return IssuedKey{}, err
	}
	readOnly := false
	if input.ReadOnly != nil {
		readOnly, err = ValidateFlag("readOnly", input.ReadOnly)
		if err != nil {
			return IssuedKey{}, err
		}
	}
	manage := false
	if input.CanManageProfiles != nil {
		manage, err = ValidateFlag("canManageProfiles", input.CanManageProfiles)
		if err != nil {
			return IssuedKey{}, err
		}
	}
	origin, err := ValidateHubURL(hubURL)
	if err != nil {
		return IssuedKey{}, err
	}
	scope, err := validateScope(input.AllowedProfiles)
	if err != nil {
		return IssuedKey{}, err
	}
	secret := newSecret()
	var created vault.APIKey
	err = vault.Update(func(c *vault.Contents) error {
		id := newKeyID()
		for containsID(c.Config.APIKeys, id) {
			id = newKeyID()
		}
		manageCopy := manage
		created = vault.APIKey{
			ID: id, Name: name, SecretHash: hashSecret(secret), Hint: hintOf(secret),
			AllowedProfiles: scope, ReadOnly: readOnly, CanManageProfiles: &manageCopy,
			CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		}
		c.Config.APIKeys = append(c.Config.APIKeys, created)
		return nil
	})
	if err != nil {
		return IssuedKey{}, err
	}
	token, err := auth.EncodeToken(auth.TokenParts{URL: origin, Kid: created.ID, Secret: secret})
	if err != nil {
		return IssuedKey{}, err
	}
	return IssuedKey{Key: view(created), Token: token}, nil
}

func validateScope(scope any) (vault.Scope, error) {
	if scope == "*" {
		return vault.Scope{All: true}, nil
	}
	list, ok := scope.([]string)
	if !ok || len(list) == 0 {
		return vault.Scope{}, clierr.New(clierr.InvalidParams, `allowedProfiles must be "*" or a non-empty list of service/name`, "")
	}
	known, err := knownRefs()
	if err != nil {
		return vault.Scope{}, err
	}
	var unknown []string
	seen := map[string]bool{}
	var refs []string
	for _, s := range list {
		if !known[s] {
			unknown = append(unknown, s)
			continue
		}
		if !seen[s] {
			seen[s] = true
			refs = append(refs, s)
		}
	}
	if len(unknown) > 0 {
		msg := "Unknown profile: " + unknown[0]
		if len(unknown) > 1 {
			msg = "Unknown profiles: " + joinComma(unknown)
		}
		return vault.Scope{}, clierr.New(clierr.InvalidParams, msg, "Use service/name pairs from `agentio profile list`")
	}
	return vault.Scope{Refs: refs}, nil
}

func knownRefs() (map[string]bool, error) {
	refs, err := List("", nil)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, r := range refs {
		out[RefOf(r.Service, r.Name)] = true
	}
	return out, nil
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}

func containsID(keys []vault.APIKey, id string) bool {
	for _, k := range keys {
		if k.ID == id {
			return true
		}
	}
	return false
}

func findKey(keys []vault.APIKey, id string) int {
	for i, k := range keys {
		if k.ID == id {
			return i
		}
	}
	return -1
}

func noKey(id string) *clierr.Error {
	return clierr.New(clierr.NotFound, "No key with id "+id, "Run: agentio key list")
}

func withKey(id string, mutate func(k *vault.APIKey, c *vault.Contents) error) error {
	return vault.Update(func(c *vault.Contents) error {
		i := findKey(c.Config.APIKeys, id)
		if i == -1 {
			return noKey(id)
		}
		k := &c.Config.APIKeys[i]
		if k.CanAddProfiles != nil {
			if k.CanManageProfiles == nil {
				v := *k.CanAddProfiles
				k.CanManageProfiles = &v
			}
			k.CanAddProfiles = nil
		}
		return mutate(k, c)
	})
}

func UpdateKey(id string, patch KeyInput) (KeyView, error) {
	var out KeyView
	err := withKey(id, func(k *vault.APIKey, c *vault.Contents) error {
		if patch.Name != nil {
			s, ok := patch.Name.(string)
			if !ok {
				return clierr.New(clierr.InvalidParams, fmt.Sprintf("A key needs a name of 1 to %d characters", maxKeyName), "")
			}
			name, err := ValidateKeyName(s)
			if err != nil {
				return err
			}
			k.Name = name
		}
		if patch.AllowedProfiles != nil {
			scope, err := validateScope(patch.AllowedProfiles)
			if err != nil {
				return err
			}
			k.AllowedProfiles = scope
		}
		if patch.ReadOnly != nil {
			b, err := ValidateFlag("readOnly", patch.ReadOnly)
			if err != nil {
				return err
			}
			k.ReadOnly = b
		}
		if patch.CanManageProfiles != nil {
			b, err := ValidateFlag("canManageProfiles", patch.CanManageProfiles)
			if err != nil {
				return err
			}
			k.CanManageProfiles = &b
		}
		out = view(*k)
		return nil
	})
	return out, err
}

func RotateKey(id, hubURL string) (IssuedKey, error) {
	origin, err := ValidateHubURL(hubURL)
	if err != nil {
		return IssuedKey{}, err
	}
	secret := newSecret()
	var out KeyView
	err = withKey(id, func(k *vault.APIKey, c *vault.Contents) error {
		k.SecretHash = hashSecret(secret)
		k.Hint = hintOf(secret)
		out = view(*k)
		return nil
	})
	if err != nil {
		return IssuedKey{}, err
	}
	token, err := auth.EncodeToken(auth.TokenParts{URL: origin, Kid: id, Secret: secret})
	if err != nil {
		return IssuedKey{}, err
	}
	return IssuedKey{Key: out, Token: token}, nil
}

func RevokeKey(id string) error {
	return vault.Update(func(c *vault.Contents) error {
		i := findKey(c.Config.APIKeys, id)
		if i == -1 {
			return noKey(id)
		}
		c.Config.APIKeys = append(c.Config.APIKeys[:i], c.Config.APIKeys[i+1:]...)
		return nil
	})
}

// Authenticate returns the key a token proves, or nil. Malformed tokens are nil.
func Authenticate(token string) (*KeyView, error) {
	parts, err := auth.DecodeToken(token)
	if err != nil {
		return nil, nil
	}
	c, err := vault.Load()
	if err != nil {
		return nil, err
	}
	i := findKey(c.Config.APIKeys, parts.Kid)
	if i == -1 || !secretMatches(parts.Secret, c.Config.APIKeys[i].SecretHash) {
		return nil, nil
	}
	v := view(c.Config.APIKeys[i])
	return &v, nil
}

func KeyAllows(k KeyView, service, profileName string) bool {
	return k.AllowedProfiles.All || k.AllowedProfiles.Allows(RefOf(service, profileName))
}

func EffectiveReadOnly(k KeyView, profileReadOnly bool) bool {
	return k.ReadOnly || profileReadOnly
}

func TouchKey(k KeyView, at time.Time) error {
	if k.LastUsedAt != "" {
		prev, err := time.Parse(time.RFC3339, k.LastUsedAt)
		if err == nil && at.Sub(prev) < touchInterval {
			return nil
		}
		// bun toISOString has millis; try that layout too.
		if prev.IsZero() {
			prev, err = time.Parse("2006-01-02T15:04:05.000Z", k.LastUsedAt)
			if err == nil && at.Sub(prev) < touchInterval {
				return nil
			}
		}
	}
	return vault.Update(func(c *vault.Contents) error {
		i := findKey(c.Config.APIKeys, k.ID)
		if i == -1 {
			return nil
		}
		stored := &c.Config.APIKeys[i]
		if stored.LastUsedAt != "" {
			prev, err := time.Parse(time.RFC3339Nano, stored.LastUsedAt)
			if err != nil {
				prev, err = time.Parse("2006-01-02T15:04:05.000Z", stored.LastUsedAt)
			}
			if err == nil && at.Sub(prev) < touchInterval {
				return nil
			}
		}
		stored.LastUsedAt = at.UTC().Format("2006-01-02T15:04:05.000Z")
		return nil
	})
}

func reaches(c *vault.Contents, keyID, service, name string) bool {
	i := findKey(c.Config.APIKeys, keyID)
	if i == -1 {
		return false
	}
	return view(c.Config.APIKeys[i]).AllowedProfiles.Allows(RefOf(service, name)) || c.Config.APIKeys[i].AllowedProfiles.All
}

func grant(c *vault.Contents, keyID, service, name string) {
	i := findKey(c.Config.APIKeys, keyID)
	if i == -1 || c.Config.APIKeys[i].AllowedProfiles.All {
		return
	}
	ref := RefOf(service, name)
	if c.Config.APIKeys[i].AllowedProfiles.Allows(ref) {
		return
	}
	c.Config.APIKeys[i].AllowedProfiles.Refs = append(c.Config.APIKeys[i].AllowedProfiles.Refs, ref)
}

func renameScopes(c *vault.Contents, service, from, to string) {
	before := RefOf(service, from)
	after := RefOf(service, to)
	for i := range c.Config.APIKeys {
		k := &c.Config.APIKeys[i]
		if k.AllowedProfiles.All {
			continue
		}
		seen := map[string]bool{}
		var next []string
		for _, ref := range k.AllowedProfiles.Refs {
			if ref == before {
				ref = after
			}
			if seen[ref] {
				continue
			}
			seen[ref] = true
			next = append(next, ref)
		}
		k.AllowedProfiles.Refs = next
	}
}

// Prune drops key scopes that no longer name a profile. Star keys are kept.
func Prune(c *vault.Contents) { pruneScopes(c) }

func pruneScopes(c *vault.Contents) {
	known := map[string]bool{}
	for service, list := range c.Config.Profiles {
		for _, p := range list {
			known[RefOf(service, p.Name)] = true
		}
	}
	for i := range c.Config.APIKeys {
		k := &c.Config.APIKeys[i]
		if k.AllowedProfiles.All {
			continue
		}
		var kept []string
		for _, ref := range k.AllowedProfiles.Refs {
			if known[ref] {
				kept = append(kept, ref)
			}
		}
		k.AllowedProfiles.Refs = kept
	}
}

// KnownProfileRefs is the set import and scope checks use.
func KnownProfileRefs() (map[string]bool, error) { return knownRefs() }
