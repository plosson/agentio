package vault

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// ProfileValue is one config.profiles entry. Older vaults stored a bare
// string; new writes store {"name","readOnly?"}. An entry keeps the form it
// was read in, and any keys Go does not model.
type ProfileValue struct {
	Name     string
	ReadOnly bool

	bare          bool
	readOnlyFalse bool
	extra         map[string]json.RawMessage
}

func (p ProfileValue) MarshalJSON() ([]byte, error) {
	if p.bare && !p.ReadOnly {
		return json.Marshal(p.Name)
	}
	obj := struct {
		Name     string `json:"name"`
		ReadOnly *bool  `json:"readOnly,omitempty"`
	}{Name: p.Name}
	if p.ReadOnly || p.readOnlyFalse {
		obj.ReadOnly = &p.ReadOnly
	}
	b, err := json.Marshal(obj)
	if err != nil {
		return nil, err
	}
	return withUnknown(b, p.extra)
}

func (p *ProfileValue) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		return fmt.Errorf("null profile entry")
	}
	*p = ProfileValue{}
	if b[0] == '"' {
		p.bare = true
		return json.Unmarshal(b, &p.Name)
	}
	var obj struct {
		Name     string `json:"name"`
		ReadOnly *bool  `json:"readOnly"`
	}
	if err := json.Unmarshal(b, &obj); err != nil {
		return err
	}
	if obj.Name == "" {
		return fmt.Errorf("profile entry has no name")
	}
	extra, err := unknownMembers(b, "name", "readOnly")
	if err != nil {
		return err
	}
	p.Name = obj.Name
	p.ReadOnly = obj.ReadOnly != nil && *obj.ReadOnly
	p.readOnlyFalse = obj.ReadOnly != nil && !*obj.ReadOnly
	p.extra = extra
	return nil
}

// Scope is an API key allow-list: "*" or service/name pairs.
type Scope struct {
	All  bool
	Refs []string
}

func (s Scope) MarshalJSON() ([]byte, error) {
	if s.All {
		return []byte(`"*"`), nil
	}
	refs := s.Refs
	if refs == nil {
		refs = []string{}
	}
	return json.Marshal(refs)
}

func (s *Scope) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if string(b) == `"*"` {
		s.All = true
		s.Refs = nil
		return nil
	}
	s.All = false
	return json.Unmarshal(b, &s.Refs)
}

func (s Scope) Allows(ref string) bool {
	if s.All {
		return true
	}
	for _, r := range s.Refs {
		if r == ref {
			return true
		}
	}
	return false
}

// APIKey is a hub credential. The secret is never stored, only its SHA-256.
// CanAddProfiles is the v2.4 spelling of CanManageProfiles.
type APIKey struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	SecretHash        string `json:"secretHash"`
	Hint              string `json:"hint,omitempty"`
	AllowedProfiles   Scope  `json:"allowedProfiles"`
	ReadOnly          bool   `json:"readOnly"`
	CanManageProfiles *bool  `json:"canManageProfiles,omitempty"`
	CanAddProfiles    *bool  `json:"canAddProfiles,omitempty"`
	CreatedAt         string `json:"createdAt"`
	LastUsedAt        string `json:"lastUsedAt,omitempty"`

	extra map[string]json.RawMessage
}

func (k APIKey) MarshalJSON() ([]byte, error) {
	type plain APIKey
	b, err := json.Marshal(plain(k))
	if err != nil {
		return nil, err
	}
	return withUnknown(b, k.extra)
}

func (k *APIKey) UnmarshalJSON(b []byte) error {
	type plain APIKey
	var v plain
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	extra, err := unknownMembers(b, "id", "name", "secretHash", "hint", "allowedProfiles",
		"readOnly", "canManageProfiles", "canAddProfiles", "createdAt", "lastUsedAt")
	if err != nil {
		return err
	}
	*k = APIKey(v)
	k.extra = extra
	return nil
}

func (k APIKey) Manage() bool {
	if k.CanManageProfiles != nil {
		return *k.CanManageProfiles
	}
	if k.CanAddProfiles != nil {
		return *k.CanAddProfiles
	}
	return false
}

// Config keeps keys Go does not model, such as the MCP OAuth state in "server".
type Config struct {
	Profiles map[string][]ProfileValue `json:"profiles"`
	APIKeys  []APIKey                  `json:"apiKeys,omitempty"`

	extra map[string]json.RawMessage
}

func (c Config) MarshalJSON() ([]byte, error) {
	type plain Config
	b, err := json.Marshal(plain(c))
	if err != nil {
		return nil, err
	}
	return withUnknown(b, c.extra)
}

func (c *Config) UnmarshalJSON(b []byte) error {
	type plain Config
	var v plain
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	extra, err := unknownMembers(b, "profiles", "apiKeys")
	if err != nil {
		return err
	}
	*c = Config(v)
	c.extra = extra
	return nil
}

// Contents is the decrypted vault document. Top-level keys Go does not model
// survive a load and save.
type Contents struct {
	Version     int                                  `json:"version"`
	Config      Config                               `json:"config"`
	Credentials map[string]map[string]map[string]any `json:"credentials"`

	extra map[string]json.RawMessage
}

func (c Contents) MarshalJSON() ([]byte, error) {
	type plain Contents
	b, err := json.Marshal(plain(c))
	if err != nil {
		return nil, err
	}
	return withUnknown(b, c.extra)
}

func (c *Contents) UnmarshalJSON(b []byte) error {
	type plain Contents
	var v plain
	if err := decodeNumbers(b, &v); err != nil {
		return err
	}
	extra, err := unknownMembers(b, "version", "config", "credentials")
	if err != nil {
		return err
	}
	*c = Contents(v)
	c.extra = extra
	return nil
}

func (c *Contents) normalize() {
	if c.Config.Profiles == nil {
		c.Config.Profiles = map[string][]ProfileValue{}
	}
	if c.Credentials == nil {
		c.Credentials = map[string]map[string]map[string]any{}
	}
}

func decodeContents(raw []byte) (*Contents, error) {
	var c Contents
	if err := decodeNumbers(raw, &c); err != nil {
		return nil, err
	}
	c.normalize()
	return &c, nil
}

func EmptyContents() *Contents {
	c := &Contents{Version: CurrentVersion}
	c.normalize()
	return c
}

// CloneMap deep-copies a credential object so callers cannot alias the cache.
func CloneMap(in map[string]any) (map[string]any, error) {
	if in == nil {
		return nil, nil
	}
	b, err := json.Marshal(in)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var out map[string]any
	if err := dec.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// AsInt64 reads a JSON number stored in a credential map.
func AsInt64(v any) (int64, bool) {
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
