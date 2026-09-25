package jsvalue

import (
	"encoding/json"
	"errors"
	"math"
	"math/big"
	"strconv"
	"strings"
)

// NumberString is String(n): NaN and Infinity by name, exponent notation
// outside [1e-6, 1e21), the shortest decimal otherwise, and -0 as "0".
func NumberString(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	if abs := math.Abs(f); abs >= 1e21 || abs < 1e-6 {
		mant, exp, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
		return mant + "e" + exp[:1] + strings.TrimLeft(exp[1:], "0")
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// String is String(v) for a Parse value or a plain Go scalar.
func String(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case undefinedValue:
		return "undefined"
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return string(t)
		}
		return NumberString(f)
	case float64:
		return NumberString(t)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			if e != nil {
				parts[i] = String(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// Truthy is `!!v` for a Parse value or a plain Go scalar.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedValue:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0 && !math.IsNaN(f)
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int64:
		return x != 0
	case int:
		return x != 0
	default:
		return true
	}
}

// Number is Number(s): surrounding whitespace is ignored, an empty string is
// 0, 0x/0o/0b prefixes are read, and anything unparsable is NaN.
func Number(s string) float64 {
	s = Trim(s)
	if s == "" {
		return 0
	}
	lower := strings.ToLower(s)
	for _, p := range []struct {
		prefix string
		base   int
	}{{"0x", 16}, {"0o", 8}, {"0b", 2}} {
		if strings.HasPrefix(lower, p.prefix) {
			n, ok := new(big.Int).SetString(s[2:], p.base)
			if !ok || strings.ContainsAny(s[2:], "+-_") {
				return math.NaN()
			}
			f, _ := new(big.Float).SetInt(n).Float64()
			return f
		}
	}
	switch s {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r == '.' || r == 'e' || r == 'E' || r == '+' || r == '-') {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// ParseInt is parseInt(s, 10).
func ParseInt(s string) float64 { return ParseIntRadix(s, 10) }

// ParseIntRadix is parseInt(s, radix): leading JavaScript whitespace, one
// sign, a 0x/0X prefix only when radix is 16 or 0 (0 is otherwise 10), then
// the longest run of digits; NaN when there are none or radix is outside
// 2..36. Results past 2^53 round as JavaScriptCore does: radix 10 as a
// decimal literal, powers of two from the last digit up, others as summed.
func ParseIntRadix(s string, radix int) float64 {
	s = strings.TrimLeftFunc(s, IsSpace)
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg, s = s[0] == '-', s[1:]
	}
	stripPrefix := radix == 0 || radix == 16
	if radix == 0 {
		radix = 10
	} else if radix < 2 || radix > 36 {
		return math.NaN()
	}
	if stripPrefix && len(s) >= 2 && s[0] == '0' && (s[1] == 'x' || s[1] == 'X') {
		s, radix = s[2:], 16
	}
	n, end := 0.0, 0
	for ; end < len(s); end++ {
		d := digitValue(s[end])
		if d >= radix {
			break
		}
		n = float64(n*float64(radix)) + float64(d) // rounded twice, not fused
	}
	if end == 0 {
		return math.NaN()
	}
	if n >= 1<<53 {
		switch radix {
		case 10:
			n, _ = strconv.ParseFloat(s[:end], 64)
		case 2, 4, 8, 16, 32:
			n = parseIntOverflow(s[:end], radix)
		}
	}
	if neg {
		n = -n
	}
	return n
}

// digitValue is c as a base-36 digit, 36 when it is none.
func digitValue(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'z':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'Z':
		return int(c-'A') + 10
	}
	return 36
}

// parseIntOverflow is JavaScriptCore parseIntOverflow: digits summed from the
// last one up, the place value growing until it overflows.
func parseIntOverflow(digits string, radix int) float64 {
	n, place := 0.0, 1.0
	for i := len(digits) - 1; i >= 0; i-- {
		if math.IsInf(place, 1) {
			if digits[i] != '0' {
				return math.Inf(1)
			}
		} else {
			n += float64(digitValue(digits[i])) * place
		}
		place *= float64(radix)
	}
	return n
}

// ToFixed is n.toFixed(digits): the exact binary value rounded, an exact tie
// going away from zero; 1e21 and above print as String(n).
func ToFixed(f float64, digits int) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.Abs(f) >= 1e21 || math.IsInf(f, 0) {
		return NumberString(f)
	}
	exact := new(big.Float).SetPrec(0).SetFloat64(f)
	scaled := new(big.Float).SetPrec(2048).Mul(exact, new(big.Float).SetPrec(2048).SetFloat64(math.Pow10(digits)))
	scaled.Abs(scaled)
	whole, _ := scaled.Int(nil)
	frac := new(big.Float).SetPrec(2048).Sub(scaled, new(big.Float).SetPrec(2048).SetInt(whole))
	if frac.Cmp(big.NewFloat(0.5)) >= 0 {
		whole.Add(whole, big.NewInt(1))
	}
	s := whole.String()
	if digits > 0 {
		for len(s) <= digits {
			s = "0" + s
		}
		s = s[:len(s)-digits] + "." + s[len(s)-digits:]
	}
	if f < 0 {
		s = "-" + s
	}
	return s
}
