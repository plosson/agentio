package jira

import "testing"

func TestCredentialsMapRoundTrip(t *testing.T) {
	c := Credentials{
		AccessToken:  "a",
		RefreshToken: "r",
		ExpiryDate:   123,
		CloudID:      "cloud",
		SiteURL:      "https://acme.atlassian.net",
	}
	m := c.ToMap()
	for _, k := range []string{"accessToken", "refreshToken", "expiryDate", "cloudId", "siteUrl"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing Bun wire key %q", k)
		}
	}
	back := CredentialsFromMap(m)
	if back != c {
		t.Fatalf("roundtrip: %+v != %+v", back, c)
	}
}
