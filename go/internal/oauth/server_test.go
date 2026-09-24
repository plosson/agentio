package oauth

import (
	"strings"
	"testing"
)

func TestParseRedirectRejectsTheWaysAPasteGoesWrong(t *testing.T) {
	if _, err := ParseRedirect("  ", "Acme", ""); err == nil {
		t.Fatal("empty paste accepted")
	}
	res, err := ParseRedirect("raw-code", "Acme", "state")
	if err != nil || res.Code != "raw-code" {
		t.Fatalf("%+v %v", res, err)
	}
	if _, err := ParseRedirect("http://localhost/callback?error=access_denied&error_description=no", "Acme", ""); err == nil || !strings.Contains(err.Error(), "access_denied") {
		t.Fatal(err)
	}
	if _, err := ParseRedirect("http://localhost/callback?code=c&state=other", "Acme", "expected"); err == nil || !strings.Contains(err.Error(), "state") {
		t.Fatal(err)
	}
	if _, err := ParseRedirect("http://localhost/callback?state=expected", "Acme", "expected"); err == nil {
		t.Fatal("missing code accepted")
	}
	res, err = ParseRedirect("http://localhost/callback?code=abc&state=expected", "Acme", "expected")
	if err != nil || res.Code != "abc" || res.State != "expected" {
		t.Fatalf("%+v %v", res, err)
	}
}
