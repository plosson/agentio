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
	kept          members
}

// StatesReadOnly is whether the entry has a readOnly member, true or false
// (Bun's entry.readOnly is not undefined).
func (p ProfileValue) StatesReadOnly() bool { return p.ReadOnly || p.readOnlyFalse }

// profileObject is the object form of a ProfileValue.
type profileObject struct {
	Name     string `json:"name"`
	ReadOnly *bool  `json:"readOnly,omitempty"`
}

func (p ProfileValue) MarshalJSON() ([]byte, error) {
	if p.bare && !p.ReadOnly {
		return json.Marshal(p.Name)
	}
	obj := profileObject{Name: p.Name}
	if p.ReadOnly || p.readOnlyFalse {
		obj.ReadOnly = &p.ReadOnly
	}
	return marshalKeeping(obj, p.kept)
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
	var obj profileObject
	kept, err := unmarshalKeeping(b, &obj)
	if err != nil {
		return err
	}
	if obj.Name == "" {
		return fmt.Errorf("profile entry has no name")
	}
	p.Name = obj.Name
	p.ReadOnly = obj.ReadOnly != nil && *obj.ReadOnly
	p.readOnlyFalse = obj.ReadOnly != nil && !*obj.ReadOnly
	p.kept = kept
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

	kept members
}

type plainAPIKey APIKey

func (k APIKey) MarshalJSON() ([]byte, error) { return marshalKeeping(plainAPIKey(k), k.kept) }

func (k *APIKey) UnmarshalJSON(b []byte) (err error) {
	k.kept, err = unmarshalKeeping(b, (*plainAPIKey)(k))
	return err
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
	Profiles Profiles `json:"profiles"`
	APIKeys  []APIKey `json:"apiKeys,omitempty"`

	kept members
}

type plainConfig Config

func (c Config) MarshalJSON() ([]byte, error) { return marshalKeeping(plainConfig(c), c.kept) }

func (c *Config) UnmarshalJSON(b []byte) (err error) {
	c.kept, err = unmarshalKeeping(b, (*plainConfig)(c))
	return err
}

// Contents is the decrypted vault document. Top-level keys Go does not model
// survive a load and save.
type Contents struct {
	Version     int         `json:"version"`
	Config      Config      `json:"config"`
	Credentials Credentials `json:"credentials"`

	kept members
}

type plainContents Contents

func (c Contents) MarshalJSON() ([]byte, error) { return marshalKeeping(plainContents(c), c.kept) }

func (c *Contents) UnmarshalJSON(b []byte) (err error) {
	c.kept, err = unmarshalKeeping(b, (*plainContents)(c))
	return err
}

func (c *Contents) normalize() {
	c.Config.Profiles.init()
	c.Credentials.init()
}

func decodeContents(raw []byte) (*Contents, error) {
	var c Contents
	if err := json.Unmarshal(raw, &c); err != nil {
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
