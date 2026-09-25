package vault

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"

	"github.com/plosson/agentio/go/internal/clierr"
	"golang.org/x/crypto/scrypt"
)

// Legacy files from before the single vault. Init reads them once, writes the
// new vault, then renames the originals to .bak.

// LegacyPaths are the pre-vault config.json and tokens.enc.
func LegacyPaths() (configPath, tokensPath string) { return legacyPaths() }

func legacyPaths() (configPath, tokensPath string) {
	dir := ConfigDir()
	return filepath.Join(dir, "config.json"), filepath.Join(dir, "tokens.enc")
}

func DetectLegacy() (hasConfig, hasTokens bool) {
	cfg, tok := legacyPaths()
	_, err1 := os.Stat(cfg)
	_, err2 := os.Stat(tok)
	return err1 == nil, err2 == nil
}

type MigrateResult struct {
	Config          Config
	Credentials     map[string]map[string]map[string]any
	TokensRecovered bool
}

func ReadLegacy() (*MigrateResult, error) {
	cfgPath, tokPath := legacyPaths()
	if _, err := os.Stat(cfgPath); err != nil {
		return nil, clierr.New(clierr.NotFound, "No legacy config.json to migrate", "Run: agentio vault init for a fresh install")
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return nil, clierr.New(clierr.ConfigError, "Failed to read legacy config.json: "+err.Error(), "Fix or remove the file, then run setup again")
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, clierr.New(clierr.ConfigError, "Failed to read legacy config.json: "+err.Error(), "Fix or remove the file, then run setup again")
	}
	if cfg.Profiles == nil {
		cfg.Profiles = map[string][]ProfileValue{}
	}
	result := &MigrateResult{Config: cfg, Credentials: map[string]map[string]map[string]any{}}
	if b, err := os.ReadFile(tokPath); err == nil {
		if creds := tryDecryptLegacy(string(b)); creds != nil {
			result.Credentials = creds
			result.TokensRecovered = true
		}
	}
	return result, nil
}

func ArchiveLegacy() error {
	cfg, tok := legacyPaths()
	for _, path := range []string{cfg, tok} {
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := AssertTestWritable(path, "legacy config"); err != nil {
			return err
		}
		if err := os.Rename(path, path+".bak"); err != nil {
			return err
		}
	}
	return nil
}

func tryDecryptLegacy(raw string) map[string]map[string]map[string]any {
	var blob struct {
		IV   string `json:"iv"`
		Tag  string `json:"tag"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal([]byte(raw), &blob); err != nil {
		return nil
	}
	iv, err1 := hex.DecodeString(blob.IV)
	tag, err2 := hex.DecodeString(blob.Tag)
	data, err3 := hex.DecodeString(blob.Data)
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}
	key, err := legacyKey()
	if err != nil {
		return nil
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil
	}
	aead, err := cipher.NewGCMWithNonceSize(block, len(iv))
	if err != nil {
		return nil
	}
	sealed := append(append([]byte{}, data...), tag...)
	plain, err := aead.Open(nil, iv, sealed, nil)
	if err != nil {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.UseNumber()
	var creds map[string]map[string]map[string]any
	if err := dec.Decode(&creds); err != nil {
		return nil
	}
	return creds
}

func legacyKey() ([]byte, error) {
	host, err := os.Hostname()
	if err != nil {
		return nil, err
	}
	u, err := user.Current()
	if err != nil {
		return nil, err
	}
	machine := host + "-" + u.Username + "-agentio-v1"
	return scrypt.Key([]byte(machine), []byte("agentio-salt"), scryptN, scryptR, scryptP, keyLen)
}

// RemoveLegacyBackups deletes the config.json.bak and tokens.enc.bak a
// migration left, as Bun's vault reset does. A failed delete is ignored.
func RemoveLegacyBackups() error {
	configPath, tokensPath := legacyPaths()
	for _, p := range []string{configPath + ".bak", tokensPath + ".bak"} {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		if err := AssertTestWritable(p, "legacy backup"); err != nil {
			return err
		}
		_ = os.Remove(p)
	}
	return nil
}
