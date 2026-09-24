package obscure

import "testing"

func TestRevealRoundTripAndRejectsTruncation(t *testing.T) {
	enc, err := Obscure("client-secret")
	if err != nil {
		t.Fatal(err)
	}
	got, err := Reveal(enc)
	if err != nil || got != "client-secret" {
		t.Fatalf("%q %v", got, err)
	}
	if _, err := Reveal("aaaa"); err == nil {
		t.Fatal("short value revealed")
	}
}
