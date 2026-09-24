package google

import (
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
)

// FormatBytes is Bun format.ts formatBytes: one decimal, trailing ".0"
// dropped, units up to GB (a larger value prints "undefined" as Bun does).
func FormatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	sizes := []string{"B", "KB", "MB", "GB"}
	i := int(math.Floor(math.Log(float64(bytes)) / math.Log(1024)))
	unit := "undefined"
	if i >= 0 && i < len(sizes) {
		unit = sizes[i]
	}
	value := float64(bytes) / math.Pow(1024, float64(i))
	return strconv.FormatFloat(toFixed1(value), 'f', -1, 64) + " " + unit
}

// toFixed1 is parseFloat(x.toFixed(1)): the exact binary value rounded to one
// decimal, a tie going up (JavaScript picks the larger n).
func toFixed1(x float64) float64 {
	exact := new(big.Float).SetPrec(256).SetFloat64(x)
	exact.Mul(exact, big.NewFloat(10))
	floor, _ := exact.Int(nil)
	if exact.Sign() < 0 && new(big.Float).SetInt(floor).Cmp(exact) != 0 {
		floor.Sub(floor, big.NewInt(1))
	}
	rem := new(big.Float).SetPrec(256).Sub(exact, new(big.Float).SetInt(floor))
	if rem.Cmp(big.NewFloat(0.5)) >= 0 {
		floor.Add(floor, big.NewInt(1))
	}
	n, _ := new(big.Float).SetInt(floor).Float64()
	return n / 10
}

// Truncate is Bun `s.length > n ? s.slice(0, n) + '...' : s` over UTF-16 units.
func Truncate(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n])) + "..."
}

// ParseInt is JavaScript parseInt(s, 10): leading digits after optional
// whitespace and sign, NaN when there are none.
func ParseInt(s string) float64 {
	s = strings.TrimLeftFunc(s, unicode.IsSpace)
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return math.NaN()
	}
	n, _ := strconv.ParseFloat(s[:end], 64)
	if neg {
		n = -n
	}
	return n
}

// JSNumber is String(n) for the integers ParseInt returns, NaN included.
func JSNumber(n float64) string {
	if math.IsNaN(n) {
		return "NaN"
	}
	if n == 0 {
		return "0" // String(-0) is "0"
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

// ISOString is Date.toISOString: UTC, milliseconds, truncated.
func ISOString(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
