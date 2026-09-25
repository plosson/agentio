package vault

import (
	"os"
	"strings"
	"sync"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
)

const MinPassphraseLen = 8

// Passphrase resolution matches src/vault/passphrase.ts:
// AGENTIO_PASSPHRASE, then the in-process cache, then the passphrase file.
// The daemon installs a memory-only provider so the file is never consulted.

// passMu guards the in-process state below: daemon handlers lock, unlock and
// look up credentials concurrently.
var (
	passMu     sync.Mutex
	memPass    string
	memSet     bool
	memoryOnly bool
)

func ResetPassphrase() {
	passMu.Lock()
	defer passMu.Unlock()
	memPass = ""
	memSet = false
	memoryOnly = false
}

// SetMemoryOnly makes getPassphrase ignore the passphrase file. The daemon
// uses this so it stays locked until someone unlocks it.
func SetMemoryOnly(on bool) {
	passMu.Lock()
	defer passMu.Unlock()
	memoryOnly = on
}

func SetMemoryPassphrase(p string) { setMemory(p, true) }

// memory returns the in-process passphrase, whether one is set, and whether
// the passphrase file is ignored.
func memory() (pass string, set, only bool) {
	passMu.Lock()
	defer passMu.Unlock()
	return memPass, memSet, memoryOnly
}

func setMemory(pass string, set bool) {
	passMu.Lock()
	defer passMu.Unlock()
	memPass = pass
	memSet = set
}

func HasResidentPassphrase() bool {
	if os.Getenv("AGENTIO_PASSPHRASE") != "" {
		return true
	}
	_, set, _ := memory()
	return set
}

type passSource string

const (
	fromEnv    passSource = "env"
	fromMemory passSource = "memory"
	fromFile   passSource = "file"
	fromNone   passSource = ""
)

func lookupPassphrase() (string, passSource) {
	// Verbatim, as Bun: a passphrase may start or end with a space.
	if v := os.Getenv("AGENTIO_PASSPHRASE"); v != "" {
		return v, fromEnv
	}
	pass, set, only := memory()
	if set {
		return pass, fromMemory
	}
	if only {
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
	if _, _, only := memory(); only {
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
		return writePrivate(path, raw)
	}
	path := PassphrasePath()
	if err := AssertTestWritable(path, "passphrase file"); err != nil {
		return err
	}
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return nodefs.NodeFSError("mkdir", ConfigDir(), err)
	}
	return writePrivate(path, []byte(passphrase))
}

// writePrivate is writeFileSync(path, data, { mode: 0o600 }), failing with
// Node's message.
func writePrivate(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nodefs.NodeFSError("open", path, err)
	}
	return nil
}

func ClearPassphrase() error {
	setMemory("", false)
	if _, _, only := memory(); only {
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
	if jsvalue.Length(passphrase) < MinPassphraseLen { // String#length
		return clierr.New(clierr.InvalidParams,
			"Passphrase must be at least 8 characters", "")
	}
	return nil
}
