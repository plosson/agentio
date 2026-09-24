package vault

import (
        "os"
        "path/filepath"
        "runtime"
        "strings"
        "testing"
)

func TestRoundTrip(t *testing.T) {
        plain := `{"version":1,"config":{"profiles":{}},"credentials":{}}`
        enc, err := Encrypt(plain, "secret")
        if err != nil {
                t.Fatal(err)
        }
        got, err := Decrypt(enc, "secret")
        if err != nil {
                t.Fatal(err)
        }
        if got != plain {
                t.Fatalf("mismatch: %q", got)
        }
}

func TestDecryptBunFixture(t *testing.T) {
        _, file, _, ok := runtime.Caller(0)
        if !ok {
                t.Fatal("no caller")
        }
        // go/internal/vault -> go/testdata
        fixture := filepath.Join(filepath.Dir(file), "..", "..", "testdata", "vault.fixture.b64")
        raw, err := os.ReadFile(fixture)
        if err != nil {
                t.Fatal(err)
        }
        enc := strings.TrimSpace(string(raw))
        plain, err := Decrypt(enc, "go-port-skeleton-test")
        if err != nil {
                t.Fatal(err)
        }
        if !strings.Contains(plain, `"gmail"`) || !strings.Contains(plain, "fixture@example.com") {
                t.Fatalf("unexpected plaintext: %s", plain)
        }
}
