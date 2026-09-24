package vault

import (
	"os"
	"strings"

	"github.com/plosson/agentio/go/internal/clierr"
)

const MinPassphraseLen = 8

// Passphrase resolution matches src/vault/passphrase.ts:
// AGENTIO_PASSPHRASE, then the in-process cache, then the passphrase file.
// The daemon installs a memory-only provider so the file is never consulted.

var (
	memPass    string
	memSet     bool
	memoryOnly bool
)

func ResetPassphrase() {
	memPass = ""
	memSet = false
	memoryOnly = false
}

// SetMemoryOnly makes getPassphrase ignore the passphrase file. The daemon
// uses this so it stays locked until someone unlocks it.
func SetMemoryOnly(on bool) { memoryOnly = on }

func SetMemoryPassphrase(p string) {
	memPass = p
	memSet = true
}

func HasResidentPassphrase() bool {
	if strings.TrimSpace(os.Getenv("AGENTIO_PASSPHRASE")) != "" {
		return true
	}
	return memSet
}

type passSource string

const (
	fromEnv    passSource = "env"
	fromMemory passSource = "memory"
	fromFile   passSource = "file"
	fromNone   passSource = ""
)

func lookupPassphrase() (string, passSource) {
	if v := strings.TrimSpace(os.Getenv("AGENTIO_PASSPHRASE")); v != "" {
		return v, fromEnv
	}
	if memSet {
		return memPass, fromMemory
	}
	if memoryOnly {
		return "", fromNone
	}
	if store := os.Getenv("AGENTIO_PASSPHRASE_STORE"); strings.HasPrefix(store, "memory:") {
		return readMemoryStore(store[len("memory:"):])
	}
	b, err := os.ReadFile(PassphrasePath())
	if err != nil {
		return "", fromNone
	}
	v := strings.TrimSuffix(string(b), "\n")
	if v == "" {
		return "", fromNone
	}
	SetMemoryPassphrase(v)
	return v, fromFile
}

func readMemoryStore(path string) (string, passSource) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fromNone
	}
	var data map[string]string
	if err := jsonUnmarshal(b, &data); err != nil {
		return "", fromNone
	}
	v := data["vault"]
	if v == "" {
		return "", fromNone
	}
	SetMemoryPassphrase(v)
	return v, fromFile
}

func StorePassphrase(passphrase string) error {
	SetMemoryPassphrase(passphrase)
	if memoryOnly {
		return nil
	}
	if store := os.Getenv("AGENTIO_PASSPHRASE_STORE"); strings.HasPrefix(store, "memory:") {
		path := store[len("memory:"):]
		if err := AssertTestWritable(path, "passphrase file"); err != nil {
			return err
		}
		data := map[string]string{}
		if b, err := os.ReadFile(path); err == nil {
			_ = jsonUnmarshal(b, &data)
		}
		data["vault"] = passphrase
		raw, err := jsonMarshal(data)
		if err != nil {
			return err
		}
		return os.WriteFile(path, raw, 0o600)
	}
	path := PassphrasePath()
	if err := AssertTestWritable(path, "passphrase file"); err != nil {
		return err
	}
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(passphrase), 0o600)
}

func ClearPassphrase() error {
	memPass = ""
	memSet = false
	if memoryOnly {
		return nil
	}
	if store := os.Getenv("AGENTIO_PASSPHRASE_STORE"); strings.HasPrefix(store, "memory:") {
		path := store[len("memory:"):]
		if err := AssertTestWritable(path, "passphrase file"); err != nil {
			return err
		}
		data := map[string]string{}
		if b, err := os.ReadFile(path); err == nil {
			_ = jsonUnmarshal(b, &data)
		}
		delete(data, "vault")
		raw, err := jsonMarshal(data)
		if err != nil {
			return err
		}
		return os.WriteFile(path, raw, 0o600)
	}
	path := PassphrasePath()
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	if err := AssertTestWritable(path, "passphrase file"); err != nil {
		return err
	}
	return os.Remove(path)
}

func ValidatePassphrase(passphrase string) error {
	if len(passphrase) < MinPassphraseLen {
		return clierr.New(clierr.InvalidParams,
			"Passphrase must be at least 8 characters", "")
	}
	return nil
}
