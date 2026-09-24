package oauth

import "testing"

func TestRevealGoogleSecret(t *testing.T) {
        got, err := Reveal("H2nByOfMnoQDg9BIGMyt_hznzMMTq-Or4wsZwiqT1ldl6z7bTMIdk9L8rDzQJ4l0i_pA")
        if err != nil {
                t.Fatal(err)
        }
        if got != "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" {
                t.Fatalf("got %q", got)
        }
}
