// Package plugincache is the host-owned disk cache a plugin may use for
// disposable data. Scope is hashed so account identifiers are not filenames.
package plugincache

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/vault"
)

var safe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

func Path(pluginID, scope, name string) (string, error) {
	id, err := segment(pluginID, "plugin id")
	if err != nil {
		return "", err
	}
	n, err := segment(name, "name")
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(scope))
	return filepath.Join(vault.ConfigDir(), "cache", id, hex.EncodeToString(sum[:])[:24], n+".json"), nil
}

func segment(value, label string) (string, error) {
	if !safe.MatchString(value) {
		return "", fmt.Errorf("invalid plugin cache %s: %s", label, value)
	}
	return value, nil
}

func Read(pluginID, scope, name string, dest any) (bool, error) {
	path, err := Path(pluginID, scope, name)
	if err != nil {
		return false, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false, nil
	}
	if err := json.Unmarshal(b, dest); err != nil {
		return false, nil
	}
	return true, nil
}

func Write(pluginID, scope, name string, value any) error {
	path, err := Path(pluginID, scope, name)
	if err != nil {
		return err
	}
	if err := vault.AssertTestWritable(path, "plugin cache"); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw := jsvalue.Stringify(value) // Bun JSON.stringify(value)
	nonce := make([]byte, 6)
	_, _ = rand.Read(nonce)
	tmp := fmt.Sprintf("%s.%d.%s.tmp", path, os.Getpid(), hex.EncodeToString(nonce))
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
