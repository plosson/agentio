// Package obscure hides embedded client secrets from naive scanners.
// It is not a security boundary. The algorithm matches src/utils/obscure.ts
// (AES-256-CTR, rclone-style fixed key).
package obscure

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
)

var key []byte

func init() {
	var err error
	key, err = hex.DecodeString("9c935b2aa628f0e9d48d5f3e8a4b7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b")
	if err != nil {
		panic(err)
	}
}

func Obscure(plaintext string) (string, error) {
	iv := make([]byte, aes.BlockSize)
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	out := make([]byte, len(plaintext))
	cipher.NewCTR(block, iv).XORKeyStream(out, []byte(plaintext))
	return base64.RawURLEncoding.EncodeToString(append(iv, out...)), nil
}

func Reveal(obscured string) (string, error) {
	data, err := base64.RawURLEncoding.DecodeString(obscured)
	if err != nil || len(data) < aes.BlockSize {
		return "", fmt.Errorf("obscure: invalid value")
	}
	iv := data[:aes.BlockSize]
	enc := data[aes.BlockSize:]
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	out := make([]byte, len(enc))
	cipher.NewCTR(block, iv).XORKeyStream(out, enc)
	return string(out), nil
}
