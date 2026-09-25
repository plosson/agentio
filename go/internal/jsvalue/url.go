package jsvalue

import (
	"math"
	"strconv"
	"strings"

	"golang.org/x/net/idna"
)

// specialSchemes are the URL Standard's special schemes.
var specialSchemes = map[string]bool{"ftp": true, "file": true, "http": true, "https": true, "ws": true, "wss": true}

// URLHostname is `new URL(raw).hostname`, and ok false where the URL
// constructor throws. A special scheme's host is a domain made ASCII
// (DomainToASCII) or an IPv4 address in its canonical form; another scheme's
// host is kept as written, non-ASCII percent-encoded.
func URLHostname(raw string) (string, bool) {
	s := strings.TrimFunc(raw, func(r rune) bool { return r <= 0x20 })
	s = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s)
	colon := strings.IndexByte(s, ':')
	if colon <= 0 || !isAlpha(s[0]) {
		return "", false
	}
	for i := 1; i < colon; i++ {
		if c := s[i]; !isAlpha(c) && !(c >= '0' && c <= '9') && c != '+' && c != '-' && c != '.' {
			return "", false
		}
	}
	scheme, rest := strings.ToLower(s[:colon]), s[colon+1:]
	special := specialSchemes[scheme]
	if special {
		rest = strings.TrimLeft(rest, "/\\")
	} else if strings.HasPrefix(rest, "//") {
		rest = rest[2:]
	} else {
		return "", true // no authority: no host
	}
	end := strings.IndexAny(rest, "/?#")
	if special {
		end = strings.IndexAny(rest, "/\\?#")
	}
	if end >= 0 {
		rest = rest[:end]
	}
	if at := strings.LastIndexByte(rest, '@'); at >= 0 {
		rest = rest[at+1:]
	}
	host, port := rest, ""
	if strings.HasPrefix(host, "[") {
		close := strings.IndexByte(host, ']')
		if close < 0 {
			return "", false
		}
		host, port = host[:close+1], strings.TrimPrefix(host[close+1:], ":")
		if host != rest[:close+1] || (rest[close+1:] != "" && !strings.HasPrefix(rest[close+1:], ":")) {
			return "", false
		}
	} else if i := strings.LastIndexByte(host, ':'); i >= 0 {
		host, port = host[:i], host[i+1:]
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return "", false
		}
	}
	if n, err := strconv.Atoi(port); port != "" && (err != nil || n > 65535) {
		return "", false
	}
	if strings.HasPrefix(host, "[") {
		return strings.ToLower(host), true
	}
	if !special {
		return opaqueHost(host)
	}
	if host == "" {
		return "", false
	}
	ascii, ok := DomainToASCII(host)
	if !ok {
		return "", false
	}
	if endsInANumber(ascii) {
		return ipv4(ascii)
	}
	return ascii, true
}

func isAlpha(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

// opaqueHost is a non-special scheme's host: forbidden code points refused,
// anything outside ASCII percent-encoded.
func opaqueHost(host string) (string, bool) {
	var b strings.Builder
	for _, r := range host {
		if r == 0 || r == ' ' || strings.ContainsRune("#/:<>?@[\\]^|", r) {
			return "", false
		}
		if r > 0x7e || r < 0x20 {
			for _, c := range []byte(string(r)) {
				b.WriteString("%" + strings.ToUpper(strconv.FormatInt(int64(c)|0x100, 16)[1:]))
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String(), true
}

// endsInANumber is the URL Standard's test for a host to parse as IPv4.
func endsInANumber(host string) bool {
	parts := strings.Split(host, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	_, ok := ipv4Number(last)
	return ok
}

// ipv4Number is one part of an IPv4 host: decimal, 0x hex or 0 octal.
func ipv4Number(part string) (uint64, bool) {
	if part == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(part) >= 2 && (part[:2] == "0x" || part[:2] == "0X"):
		part, base = part[2:], 16
	case len(part) >= 2 && part[0] == '0':
		part, base = part[1:], 8
	}
	if part == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(part, base, 64)
	if err != nil {
		return 0, false
	}
	return n, true
}

// ipv4 is the URL Standard's IPv4 parser, serialized dotted-decimal.
func ipv4(host string) (string, bool) {
	parts := strings.Split(host, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", false
	}
	nums := make([]uint64, len(parts))
	for i, p := range parts {
		n, ok := ipv4Number(p)
		if !ok {
			return "", false
		}
		nums[i] = n
	}
	for _, n := range nums[:len(nums)-1] {
		if n > 255 {
			return "", false
		}
	}
	lastMax := uint64(math.Pow(256, float64(5-len(nums))))
	if nums[len(nums)-1] >= lastMax {
		return "", false
	}
	v := nums[len(nums)-1]
	for i, n := range nums[:len(nums)-1] {
		v += n << (8 * uint(3-i))
	}
	return strconv.FormatUint(v>>24&255, 10) + "." + strconv.FormatUint(v>>16&255, 10) + "." +
		strconv.FormatUint(v>>8&255, 10) + "." + strconv.FormatUint(v&255, 10), true
}

// whatwgIDNA is UTS #46 ToASCII as the URL Standard's "domain to ASCII"
// calls it: non-transitional, CheckHyphens, UseSTD3ASCIIRules and
// VerifyDnsLength off, CheckBidi and CheckJoiners on.
var whatwgIDNA = idna.New(
	idna.MapForLookup(),
	idna.Transitional(false),
	idna.StrictDomainName(false),
	idna.VerifyDNSLength(false),
	idna.CheckHyphens(false),
	idna.CheckJoiners(true),
	idna.BidiRule(),
)

// DomainToASCII is the host new URL() keeps for a special scheme (http,
// https, ...) from its raw text: percent-decoded, mapped and punycoded
// (Bücher.example is xn--bcher-kva.example); ok false where the URL
// constructor throws. IPv4 and IPv6 forms are not handled here.
func DomainToASCII(host string) (string, bool) {
	ascii, err := whatwgIDNA.ToASCII(BufferString([]byte(percentDecode(host))))
	if err != nil || ascii == "" {
		return "", false
	}
	for _, r := range ascii {
		if r <= 0x20 || r == 0x7f || strings.ContainsRune("#%/:<>?@[\\]^|", r) {
			return "", false
		}
	}
	return ascii, true
}

// percentDecode is the URL Standard's percent-decode: "%" and two hex
// digits become that byte; any other "%" stays.
func percentDecode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && unhex(s[i+1]) >= 0 && unhex(s[i+2]) >= 0 {
			b.WriteByte(byte(unhex(s[i+1])<<4 | unhex(s[i+2])))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
