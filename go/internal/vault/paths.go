package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
)

const defaultVaultFilename = "agentio.vault"

func ConfigDir() string {
	home := os.Getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".config", "agentio")
}

func PointerPath() string { return filepath.Join(ConfigDir(), "vault.path") }

func DefaultVaultPath() string { return filepath.Join(ConfigDir(), "vault.enc") }

func PassphrasePath() string { return filepath.Join(ConfigDir(), "vault.passphrase") }

func TokenPath() string { return filepath.Join(ConfigDir(), "token") }

// AssertTestWritable refuses vault, pointer, and token writes outside the OS
// temp directory when AGENTIO_TEST=1. A test that forgets to point HOME at a
// temp dir must fail loudly.
func AssertTestWritable(path, what string) error {
	if os.Getenv("AGENTIO_TEST") != "1" {
		return nil
	}
	rel, err := filepath.Rel(os.TempDir(), path)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return fmt.Errorf("refusing to write a %s outside %s during tests: %s", what, os.TempDir(), path)
	}
	return nil
}

func ValidateVaultPath(path string) error {
	if !filepath.IsAbs(path) {
		return clierr.New(clierr.InvalidParams, "Vault path must be absolute", "Use a path like /Users/you/agentio.vault")
	}
	return nil
}

// NormalizeVaultPath appends the default filename when path is a directory
// or ends in a slash.
func NormalizeVaultPath(path string) string {
	trailing := strings.HasSuffix(path, "/")
	resolved := path
	if trailing {
		resolved = strings.TrimSuffix(path, "/")
	}
	info, err := os.Stat(resolved)
	if err == nil && info.IsDir() {
		return filepath.Join(resolved, defaultVaultFilename)
	}
	if err != nil && trailing {
		return filepath.Join(resolved, defaultVaultFilename)
	}
	return resolved
}
