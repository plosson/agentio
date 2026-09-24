package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const (
	saltLen = 32
	ivLen   = 16
	tagLen  = 16
	keyLen  = 32
	scryptN = 16384
	scryptR = 8
	scryptP = 1
)

// CurrentVersion is the on-disk vault payload version. Bump it if scrypt
// parameters change. Matches src/vault/crypto.ts CURRENT_VERSION.
const CurrentVersion = 1

// Encrypt produces the Bun vault wire format: base64(salt || iv || ciphertext || tag)
// with AES-256-GCM and scrypt N=16384, r=8, p=1. The IV is 16 bytes, which is
// what Node's createCipheriv accepts for GCM.
func Encrypt(plaintext, passphrase string) (string, error) {
	salt := make([]byte, saltLen)
	iv := make([]byte, ivLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	key, err := deriveKey(passphrase, salt)
	if err != nil {
		return "", err
	}
	gcm, err := gcm(key)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	buf := make([]byte, 0, saltLen+ivLen+len(sealed))
	buf = append(buf, salt...)
	buf = append(buf, iv...)
	buf = append(buf, sealed...)
	return base64.StdEncoding.EncodeToString(buf), nil
}

// Decrypt reverses Encrypt. A short or non-base64 payload is an error.
func Decrypt(encoded, passphrase string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return "", errors.New("vault: encoded payload too short")
	}
	if len(raw) < saltLen+ivLen+tagLen+1 {
		return "", errors.New("vault: encoded payload too short")
	}
	salt := raw[:saltLen]
	iv := raw[saltLen : saltLen+ivLen]
	sealed := raw[saltLen+ivLen:]
	key, err := deriveKey(passphrase, salt)
	if err != nil {
		return "", err
	}
	gcm, err := gcm(key)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, sealed, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func deriveKey(passphrase string, salt []byte) ([]byte, error) {
	return scrypt.Key([]byte(passphrase), salt, scryptN, scryptR, scryptP, keyLen)
}

func gcm(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithNonceSize(block, ivLen)
}

// StructurallyValid reports whether the blob is long enough to be a vault,
// so a failed decrypt can be told apart from a corrupt file.
func StructurallyValid(encoded string) bool {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return false
	}
	return len(raw) >= saltLen+ivLen+tagLen+1
}
