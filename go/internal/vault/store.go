package vault

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
)

// The cache is keyed on the vault file and its mtime, so a long-lived process
// notices a write from another process. A hit costs one stat.

var (
	storeMu    sync.Mutex
	writeMu    sync.Mutex
	cache      *Contents
	cachePath  string
	cacheMtime time.Time
)

// Reset drops process caches. Tests call it after pointing HOME elsewhere.
func Reset() {
	storeMu.Lock()
	cache = nil
	cachePath = ""
	cacheMtime = time.Time{}
	storeMu.Unlock()
	ResetPassphrase()
}

func clearCache() {
	cache = nil
	cachePath = ""
	cacheMtime = time.Time{}
}

func PointerExists() bool {
	_, err := os.Stat(PointerPath())
	return err == nil
}

func ReadPointer() (string, error) {
	b, err := os.ReadFile(PointerPath())
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(bytes.TrimSpace(b)), nil
}

func WritePointer(vaultPath string) error {
	if err := AssertTestWritable(PointerPath(), "vault pointer"); err != nil {
		return err
	}
	if err := os.MkdirAll(ConfigDir(), 0o700); err != nil {
		return err
	}
	return os.WriteFile(PointerPath(), []byte(vaultPath+"\n"), 0o600)
}

func DeletePointer() error {
	path := PointerPath()
	if _, err := os.Stat(path); err != nil {
		return nil
	}
	if err := AssertTestWritable(path, "vault pointer"); err != nil {
		return err
	}
	return os.Remove(path)
}

func Exists() bool {
	p, err := ReadPointer()
	if err != nil || p == "" {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

func requirePath() (string, error) {
	if !PointerExists() {
		return "", clierr.New(clierr.VaultNotConfigured, "No vault configured", "Run: agentio vault init")
	}
	p, err := ReadPointer()
	if err != nil {
		return "", err
	}
	if p == "" {
		return "", clierr.New(clierr.VaultNotConfigured, "No vault configured", "Run: agentio vault init")
	}
	return p, nil
}

func requireExistingPath() (string, error) {
	p, err := requirePath()
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(p); err != nil {
		return "", clierr.New(clierr.VaultNotConfigured,
			"Vault file is missing",
			"Run: agentio vault init")
	}
	return p, nil
}

// Unlocked reports whether a passphrase is already resident (env or memory).
// It does not mean a decrypt has succeeded.
func Unlocked() bool { return HasResidentPassphrase() }

// Load returns a copy of the vault contents.
func Load() (*Contents, error) {
	path, err := requireExistingPath()
	if err != nil {
		return nil, err
	}
	return loadAt(path, true)
}

func loadAt(path string, wipeOnBadFile bool) (*Contents, error) {
	storeMu.Lock()
	if cache != nil && cachePath == path {
		if st, err := os.Stat(path); err == nil && st.ModTime().Equal(cacheMtime) {
			cloned, err := clone(cache)
			storeMu.Unlock()
			return cloned, err
		}
	}
	storeMu.Unlock()

	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pw, src := lookupPassphrase()
	if pw == "" {
		return nil, clierr.New(clierr.VaultLocked,
			"Vault is locked — passphrase not found",
			"Run `agentio vault set <path>` to re-store the passphrase, or set the AGENTIO_PASSPHRASE env var.")
	}
	contents, err := decryptPayload(string(encoded), pw, wipeOnBadFile && src == fromFile)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	storeMu.Lock()
	cache = contents
	cachePath = path
	cacheMtime = st.ModTime()
	cloned, err := clone(cache)
	storeMu.Unlock()
	return cloned, err
}

var errNotJSON = errors.New("vault contents are not valid JSON")

// DecryptContents decrypts a vault file and decodes its contents. It does not
// check the version.
func DecryptContents(encoded, pw string) (*Contents, error) {
	plain, err := Decrypt(encoded, pw)
	if err != nil {
		return nil, err
	}
	contents, err := decodeContents([]byte(plain))
	if err != nil {
		return nil, errNotJSON
	}
	return contents, nil
}

func decryptPayload(encoded, pw string, wipe bool) (*Contents, error) {
	contents, err := DecryptContents(encoded, pw)
	if errors.Is(err, errNotJSON) {
		return nil, clierr.New(clierr.VaultCorrupt, "Vault contents are not valid JSON", "Restore from backup or run: agentio vault reset")
	}
	if err != nil {
		if StructurallyValid(encoded) {
			if wipe {
				_ = ClearPassphrase()
			}
			suggestion := "Check the passphrase you supplied (AGENTIO_PASSPHRASE or the one you entered)"
			if wipe {
				suggestion = "If you changed the passphrase elsewhere, run: agentio vault set <path>"
			}
			return nil, clierr.New(clierr.AuthFailed, "Wrong passphrase for vault", suggestion)
		}
		return nil, clierr.New(clierr.VaultCorrupt, "Vault file is malformed", "Restore from backup or run: agentio vault reset")
	}
	if contents.Version != CurrentVersion {
		return nil, clierr.New(clierr.VaultCorrupt,
			"Unsupported vault version: "+itoa(contents.Version),
			"Upgrade agentio, or restore from backup")
	}
	return contents, nil
}

// Update applies fn to a copy and writes when the document changed.
// fn must not retain the pointer.
func Update(fn func(*Contents) error) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	path, err := requireExistingPath()
	if err != nil {
		return err
	}
	cur, err := loadAt(path, true)
	if err != nil {
		return err
	}
	next, err := clone(cur)
	if err != nil {
		return err
	}
	if err := fn(next); err != nil {
		return err
	}
	before, err := json.Marshal(cur)
	if err != nil {
		return err
	}
	after, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if bytes.Equal(before, after) {
		return nil
	}
	return writeAt(next, path)
}

// Save writes contents to the vault the pointer names.
func Save(contents *Contents) error {
	writeMu.Lock()
	defer writeMu.Unlock()
	path, err := requirePath()
	if err != nil {
		return err
	}
	return writeAt(contents, path)
}

func writeAt(contents *Contents, path string) error {
	if err := AssertTestWritable(path, "vault"); err != nil {
		return err
	}
	pw, _ := lookupPassphrase()
	if pw == "" {
		return clierr.New(clierr.VaultLocked,
			"Vault is locked — passphrase not found",
			"Run `agentio vault set <path>` to re-store the passphrase, or set the AGENTIO_PASSPHRASE env var.")
	}
	raw, err := json.Marshal(contents)
	if err != nil {
		return err
	}
	encoded, err := Encrypt(string(raw), pw)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(encoded), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	cloned, err := clone(contents)
	if err != nil {
		return err
	}
	storeMu.Lock()
	cache = cloned
	cachePath = path
	cacheMtime = st.ModTime()
	storeMu.Unlock()
	return nil
}

// Unlock verifies passphrase against the file and keeps it in memory.
// The passphrase file is not written.
func Unlock(passphrase string) error {
	path, err := requireExistingPath()
	if err != nil {
		return err
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	contents, err := decryptPayload(string(encoded), passphrase, false)
	if err != nil {
		return err
	}
	SetMemoryPassphrase(passphrase)
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	storeMu.Lock()
	cache = contents
	cachePath = path
	cacheMtime = st.ModTime()
	storeMu.Unlock()
	return nil
}

// Lock forgets the in-memory passphrase and the decrypted cache.
// An AGENTIO_PASSPHRASE env var still counts as resident, matching Bun.
func Lock() {
	setMemory("", false)
	storeMu.Lock()
	clearCache()
	storeMu.Unlock()
}

// Create writes a new vault, points at it, and stores the passphrase.
func Create(vaultPath, passphrase string, contents *Contents) error {
	if err := CreateFile(vaultPath, passphrase, contents); err != nil {
		return err
	}
	return StorePassphrase(passphrase)
}

// CreateFile writes a new vault and points at it; storing the passphrase is
// left to the caller, for which a failure is a warning. The pointer is removed
// again if the file write fails.
func CreateFile(vaultPath, passphrase string, contents *Contents) error {
	if err := ValidateVaultPath(vaultPath); err != nil {
		return err
	}
	if err := ValidatePassphrase(passphrase); err != nil {
		return err
	}
	vaultPath = NormalizeVaultPath(vaultPath)
	if err := os.MkdirAll(filepath.Dir(vaultPath), 0o700); err != nil {
		return err
	}
	if err := WritePointer(vaultPath); err != nil {
		return err
	}
	// AGENTIO_PASSPHRASE wins over memory, so point it at the new passphrase,
	// as Bun does: the file must be encrypted with what gets stored.
	prevEnv, hadEnv := os.LookupEnv("AGENTIO_PASSPHRASE")
	prev, prevSet, _ := memory()
	os.Setenv("AGENTIO_PASSPHRASE", passphrase)
	SetMemoryPassphrase(passphrase)
	if err := Save(contents); err != nil {
		_ = DeletePointer()
		if hadEnv {
			os.Setenv("AGENTIO_PASSPHRASE", prevEnv)
		} else {
			os.Unsetenv("AGENTIO_PASSPHRASE")
		}
		setMemory(prev, prevSet)
		return err
	}
	return nil
}

// ResetVault deletes the vault file, the pointer, and the stored passphrase.
func ResetVault() error {
	if p, err := ReadPointer(); err == nil && p != "" {
		if _, statErr := os.Stat(p); statErr == nil {
			if err := AssertTestWritable(p, "vault"); err != nil {
				return err
			}
			_ = os.Remove(p)
		}
	}
	if err := DeletePointer(); err != nil {
		return err
	}
	if err := ClearPassphrase(); err != nil {
		return err
	}
	Lock()
	return nil
}

func clone(c *Contents) (*Contents, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return nil, err
	}
	return decodeContents(b)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [16]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
