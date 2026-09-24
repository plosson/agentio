package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const CurrentVersion = 1

// CURRENT_VAULT_VERSION mirrors Bun CURRENT_VAULT_VERSION.
const CURRENT_VAULT_VERSION = CurrentVersion

type ProfileEntry struct {
	Name     string `json:"name"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

type Config struct {
	Profiles map[string][]ProfileEntry `json:"profiles"`
}

// VaultContents is the Bun VaultContents shape stored inside vault.enc.
// Alias kept so call sites can use either name.
type VaultContents = Contents

type Contents struct {
	Version     int                                  `json:"version"`
	Config      Config                               `json:"config"`
	Credentials map[string]map[string]map[string]any `json:"credentials"`
}

type Store struct {
	mu         sync.Mutex
	path       string
	passphrase string
	cache      *Contents
}

func ConfigDir() string {
	home := os.Getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".config", "agentio")
}

func PointerPath() string { return filepath.Join(ConfigDir(), "vault.path") }

func DefaultVaultPath() string { return filepath.Join(ConfigDir(), "vault.enc") }

func ReadPointer() (string, error) {
	b, err := os.ReadFile(PointerPath())
	if err != nil {
		return "", err
	}
	return string(bytesTrimSpace(b)), nil
}

func bytesTrimSpace(b []byte) []byte {
	i, j := 0, len(b)
	for i < j && (b[i] == ' ' || b[i] == '\n' || b[i] == '\r' || b[i] == '\t') {
		i++
	}
	for j > i && (b[j-1] == ' ' || b[j-1] == '\n' || b[j-1] == '\r' || b[j-1] == '\t') {
		j--
	}
	return b[i:j]
}

func WritePointer(vaultPath string) error {
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(PointerPath(), []byte(vaultPath+"\n"), 0o600)
}

func Open(passphrase string) (*Store, error) {
	path, err := ReadPointer()
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("VAULT_NOT_CONFIGURED: run agentio vault init")
		}
		return nil, err
	}
	return OpenPath(path, passphrase)
}

// OpenPath unlocks an existing vault at an explicit path (no pointer read).
func OpenPath(path, passphrase string) (*Store, error) {
	s := &Store{path: path, passphrase: passphrase}
	if _, err := s.Load(); err != nil {
		return nil, err
	}
	return s, nil
}

// Create writes a new empty vault file at path (does not update vault.path).
func Create(path, passphrase string) (*Store, error) {
	if path == "" {
		path = DefaultVaultPath()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); err == nil {
		return nil, fmt.Errorf("vault already exists at %s", path)
	}
	contents := Contents{
		Version:     CurrentVersion,
		Config:      Config{Profiles: map[string][]ProfileEntry{}},
		Credentials: map[string]map[string]map[string]any{},
	}
	s := &Store{path: path, passphrase: passphrase, cache: &contents}
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	return s, nil
}

// Init creates a vault and points ~/.config/agentio/vault.path at it.
func Init(path, passphrase string) (*Store, error) {
	s, err := Create(path, passphrase)
	if err != nil {
		return nil, err
	}
	if err := WritePointer(s.path); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Path() string { return s.path }

func (s *Store) Unlocked() bool { return s.passphrase != "" && s.cache != nil }

func (s *Store) Load() (*Contents, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return nil, err
	}
	plain, err := Decrypt(string(bytesTrimSpace(raw)), s.passphrase)
	if err != nil {
		return nil, err
	}
	var c Contents
	if err := json.Unmarshal([]byte(plain), &c); err != nil {
		return nil, fmt.Errorf("vault corrupt: %w", err)
	}
	if c.Version != CurrentVersion {
		return nil, fmt.Errorf("unsupported vault version %d", c.Version)
	}
	if c.Config.Profiles == nil {
		c.Config.Profiles = map[string][]ProfileEntry{}
	}
	if c.Credentials == nil {
		c.Credentials = map[string]map[string]map[string]any{}
	}
	s.cache = &c
	return s.cache, nil
}

func (s *Store) Update(fn func(*Contents) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		return errors.New("vault not loaded")
	}
	b, _ := json.Marshal(s.cache)
	var copy Contents
	_ = json.Unmarshal(b, &copy)
	if err := fn(&copy); err != nil {
		return err
	}
	s.cache = &copy
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	plain, err := json.Marshal(s.cache)
	if err != nil {
		return err
	}
	enc, err := Encrypt(string(plain), s.passphrase)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, []byte(enc), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// GetCredentials returns a profile's credential map.
func (s *Store) GetCredentials(service, profile string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		return nil, errors.New("vault locked")
	}
	svc, ok := s.cache.Credentials[service]
	if !ok {
		return nil, fmt.Errorf("no credentials for %s", service)
	}
	creds, ok := svc[profile]
	if !ok {
		return nil, fmt.Errorf("no credentials for %s/%s", service, profile)
	}
	return creds, nil
}

func (s *Store) ListProfiles(service string) []ProfileEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		return nil
	}
	return append([]ProfileEntry(nil), s.cache.Config.Profiles[service]...)
}

func (s *Store) PutProfile(service string, entry ProfileEntry, creds map[string]any) error {
	return s.Update(func(c *Contents) error {
		profiles := c.Config.Profiles[service]
		found := false
		for i, p := range profiles {
			if p.Name == entry.Name {
				profiles[i] = entry
				found = true
				break
			}
		}
		if !found {
			profiles = append(profiles, entry)
		}
		c.Config.Profiles[service] = profiles
		if c.Credentials[service] == nil {
			c.Credentials[service] = map[string]map[string]any{}
		}
		c.Credentials[service][entry.Name] = creds
		return nil
	})
}

// RemoveProfile drops a profile entry and its credentials. Returns false if the entry was absent
// (stray credentials for that name are still cleaned up).
func (s *Store) RemoveProfile(service, name string) (bool, error) {
	var removed bool
	err := s.Update(func(c *Contents) error {
		profiles := c.Config.Profiles[service]
		idx := -1
		for i, p := range profiles {
			if p.Name == name {
				idx = i
				break
			}
		}
		if idx != -1 {
			c.Config.Profiles[service] = append(profiles[:idx], profiles[idx+1:]...)
			removed = true
		}
		if c.Credentials[service] != nil {
			delete(c.Credentials[service], name)
		}
		return nil
	})
	return removed, err
}


// ListServices returns service keys that have at least one profile entry
// (Bun configuredServiceIds / keys of config.profiles).
func (s *Store) ListServices() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache == nil {
		return nil
	}
	out := make([]string, 0, len(s.cache.Config.Profiles))
	for svc, entries := range s.cache.Config.Profiles {
		if len(entries) > 0 {
			out = append(out, svc)
		}
	}
	return out
}

// RenameProfile moves a profile entry and its credentials (Bun renameProfile / moveProfile).
// Returns "ok", "absent", or "taken".
func (s *Store) RenameProfile(service, from, to string) (string, error) {
	var outcome string
	err := s.Update(func(c *Contents) error {
		profiles := c.Config.Profiles[service]
		idx := -1
		for i, p := range profiles {
			if p.Name == from {
				idx = i
				break
			}
		}
		if idx == -1 {
			outcome = "absent"
			return nil
		}
		if from != to {
			for _, p := range profiles {
				if p.Name == to {
					outcome = "taken"
					return nil
				}
			}
		}
		entry := profiles[idx]
		entry.Name = to
		profiles[idx] = entry
		c.Config.Profiles[service] = profiles
		if c.Credentials[service] != nil {
			if stored, ok := c.Credentials[service][from]; ok && from != to {
				c.Credentials[service][to] = stored
				delete(c.Credentials[service], from)
			}
		}
		outcome = "ok"
		return nil
	})
	return outcome, err
}

func ResolvePassphrase() (string, error) {
	if v := os.Getenv("AGENTIO_PASSPHRASE"); v != "" {
		return v, nil
	}
	return "", fmt.Errorf("VAULT_LOCKED: set AGENTIO_PASSPHRASE or pass --passphrase")
}
