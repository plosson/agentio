package vault

import (
        "crypto/aes"
        "crypto/cipher"
        "crypto/rand"
        "encoding/base64"
        "fmt"
        "io"

        "golang.org/x/crypto/scrypt"
)

// Must match src/vault/crypto.ts exactly for cross-language vault unlock.
const (
        saltLen = 32
        ivLen   = 16
        tagLen  = 16
        keyLen  = 32
        scryptN = 16384
        scryptR = 8
        scryptP = 1
)

// Encrypt encrypts plaintext with passphrase using AES-256-GCM + scrypt.
// Wire format: base64(salt || iv || ciphertext || tag).
func Encrypt(plaintext, passphrase string) (string, error) {
        salt := make([]byte, saltLen)
        if _, err := io.ReadFull(rand.Reader, salt); err != nil {
                return "", err
        }
        iv := make([]byte, ivLen)
        if _, err := io.ReadFull(rand.Reader, iv); err != nil {
                return "", err
        }
        key, err := scrypt.Key([]byte(passphrase), salt, scryptN, scryptR, scryptP, keyLen)
        if err != nil {
                return "", err
        }
        block, err := aes.NewCipher(key)
        if err != nil {
                return "", err
        }
        gcm, err := cipher.NewGCMWithNonceSize(block, ivLen)
        if err != nil {
                return "", err
        }
        // Node's createCipheriv('aes-256-gcm', key, iv) uses iv as nonce and
        // appends auth tag separately; Go's Seal appends the tag to ciphertext.
        sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
        // sealed = ciphertext || tag
        out := make([]byte, 0, saltLen+ivLen+len(sealed))
        out = append(out, salt...)
        out = append(out, iv...)
        out = append(out, sealed...)
        return base64.StdEncoding.EncodeToString(out), nil
}

// Decrypt reverses Encrypt / Node encryptVault.
func Decrypt(encoded, passphrase string) (string, error) {
        buf, err := base64.StdEncoding.DecodeString(encoded)
        if err != nil {
                return "", fmt.Errorf("vault: base64: %w", err)
        }
        if len(buf) < saltLen+ivLen+tagLen+1 {
                return "", fmt.Errorf("vault: encoded payload too short")
        }
        salt := buf[:saltLen]
        iv := buf[saltLen : saltLen+ivLen]
        sealed := buf[saltLen+ivLen:] // ciphertext || tag
        key, err := scrypt.Key([]byte(passphrase), salt, scryptN, scryptR, scryptP, keyLen)
        if err != nil {
                return "", err
        }
        block, err := aes.NewCipher(key)
        if err != nil {
                return "", err
        }
        gcm, err := cipher.NewGCMWithNonceSize(block, ivLen)
        if err != nil {
                return "", err
        }
        plain, err := gcm.Open(nil, iv, sealed, nil)
        if err != nil {
                return "", fmt.Errorf("vault: decrypt failed (wrong passphrase or corrupt): %w", err)
        }
        return string(plain), nil
}
