package jsvalue

import "testing"

// DomainToASCII is the host new URL() keeps for an http(s) URL, probed with
// Bun: `new URL(u).hostname`.
func TestDomainToASCIIIsWHATWG(t *testing.T) {
	for in, want := range map[string]string{
		"Bücher.example":        "xn--bcher-kva.example",
		"EXAMPLE.com":           "example.com",
		"ex%41mple.com":         "example.com",
		"ß.de":                  "xn--zca.de",
		"①.com":                 "1.com",
		"faß.ExAmple":           "xn--fa-hia.example",
		"xn--bcher-kva.example": "xn--bcher-kva.example",
		"-x-.com":               "-x-.com",
		"a..b":                  "a..b",
		"日本.jp.":                "xn--wgv71a.jp.",
	} {
		if got, ok := DomainToASCII(in); !ok || got != want {
			t.Errorf("%q: %q %v, want %q", in, got, ok, want)
		}
	}
	for _, bad := range []string{"a b.com", "a<b", "%zz.com", "a%00b"} {
		if got, ok := DomainToASCII(bad); ok {
			t.Errorf("%q accepted as %q", bad, got)
		}
	}
}

// URLHostname is new URL(u).hostname, probed with Bun; "!" is a throw.
func TestURLHostnameIsWHATWG(t *testing.T) {
	for in, want := range map[string]string{
		"https://Bücher.example/cb": "xn--bcher-kva.example", "https://EXAMPLE.com:8443/x": "example.com",
		"https://user:pw@Ex.com:1/": "ex.com", "HTTPS://X.com/": "x.com", "https:Ex.com/cb": "ex.com",
		"https:/Ex.com/cb": "ex.com", "https:///Ex.com/cb": "ex.com", "https://\\\\Ex.com/cb": "ex.com",
		"https://ex.com:abc/": "!", "https://ex.com:99999/": "!", "https://ex.com:/": "ex.com", "https:": "!",
		"https://": "!", "https://[::1/": "!", "  https://ex.com/ ": "ex.com", "ht\ttps://ex.com/": "ex.com",
		"1https://x/": "!", "https://1.2.3.4/": "1.2.3.4", "https://0x7f.1/": "127.0.0.1", "myapp://a b/": "!",
		"myapp://a%zz/": "a%zz", "https://@ex.com/": "ex.com", "myapp://EXAMPLE.com/cb": "EXAMPLE.com",
		"myapp://Bü.x/": "B%C3%BC.x", "myapp:/cb": "", "myapp:cb": "", "https://[::1]:3000/cb": "[::1]",
		"example.test/cb": "!", "https://a b.com/": "!", "https://a<b/": "!", "https://%zz.com/": "!",
	} {
		got, ok := URLHostname(in)
		if !ok {
			got = "!"
		}
		if got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}
