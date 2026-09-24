package oauth

import (
        "crypto/aes"
        "crypto/cipher"
        "encoding/base64"
        "encoding/hex"
        "fmt"
)

var obscureKey = mustHex("9c935b2aa628f0e9d48d5f3e8a4b7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b")

func mustHex(s string) []byte {
        b, err := hex.DecodeString(s)
        if err != nil {
                panic(err)
        }
        return b
}

// Reveal decodes an obscured OAuth client secret (aes-256-ctr, base64url).
func Reveal(obscured string) (string, error) {
        data, err := base64.RawURLEncoding.DecodeString(obscured)
        if err != nil {
                data, err = base64.URLEncoding.DecodeString(obscured)
                if err != nil {
                        return "", err
                }
        }
        if len(data) < 17 {
                return "", fmt.Errorf("obscured value too short")
        }
        iv, encrypted := data[:16], data[16:]
        block, err := aes.NewCipher(obscureKey)
        if err != nil {
                return "", err
        }
        stream := cipher.NewCTR(block, iv)
        out := make([]byte, len(encrypted))
        stream.XORKeyStream(out, encrypted)
        return string(out), nil
}
