package jsvalue

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// Expected values below were printed by Bun.

func mustObject(t *testing.T, raw string) *Object {
	t.Helper()
	v, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return v.(*Object)
}

func TestNumberStringIsJavaScriptsString(t *testing.T) {
	tenth, fifth := 0.1, 0.2
	cases := map[float64]string{
		0: "0", math.Copysign(0, -1): "0", 12: "12", -3: "-3", 2.5: "2.5", -3.5: "-3.5", tenth + fifth: "0.30000000000000004",
		1e21: "1e+21", 1.5e22: "1.5e+22", 1e-7: "1e-7", -2.5e-8: "-2.5e-8", 0.000001: "0.000001", 5e-324: "5e-324",
		12345678901234567890: "12345678901234567000", 123456789012345680000: "123456789012345680000",
		math.Inf(1): "Infinity", math.Inf(-1): "-Infinity", math.NaN(): "NaN",
	}
	for in, want := range cases {
		if got := NumberString(in); got != want {
			t.Errorf("%v: got %q want %q", in, got, want)
		}
	}
}

func TestToFixedRoundsTheExactBinaryValue(t *testing.T) {
	cases := []struct {
		in     float64
		digits int
		want   string
	}{
		{0.125, 2, "0.13"}, {-0.125, 2, "-0.13"}, {1.005, 2, "1.00"}, {-0.001, 2, "-0.00"}, {2.675, 2, "2.67"},
		{math.Copysign(0, -1), 2, "0.00"}, {0.05, 1, "0.1"}, {1.25, 1, "1.3"}, {1.35, 1, "1.4"}, {5, 0, "5"},
		{1e21, 2, "1e+21"}, {math.NaN(), 2, "NaN"}, {math.Inf(-1), 2, "-Infinity"},
	}
	for _, c := range cases {
		if got := ToFixed(c.in, c.digits); got != c.want {
			t.Errorf("(%v).toFixed(%d) = %s, want %s", c.in, c.digits, got, c.want)
		}
	}
}

func TestParseIntIsJavaScripts(t *testing.T) {
	cases := map[string]string{
		"10": "10", " 42abc": "42", "-5": "-5", "+7": "7", "7.9": "7", "abc": "NaN", "": "NaN", "-0": "0", "0x10": "0",
		"+": "NaN", "- 5": "NaN", "1e3": "1", "\uFEFF5": "5", "\u20285": "5", "\u00a0\u30009": "9",
		// U+0085 and U+180E are Go spaces but not JavaScript ones.
		"\u00855": "NaN", "\u180E5": "NaN",
		"123456789012345678901234567890": "1.2345678901234568e+29",
	}
	for in, want := range cases {
		if got := NumberString(ParseInt(in)); got != want {
			t.Errorf("%q: got %s want %s", in, got, want)
		}
	}
	if !math.Signbit(ParseInt("-0")) {
		t.Error("parseInt('-0') is -0")
	}
}

// Expected values are Bun's parseInt(s, radix). The large ones pin
// JavaScriptCore's rounding, which is neither exact nor a plain sum for powers
// of two, and a sum rounded at each step (no fused multiply-add) otherwise.
func TestParseIntRadixIsJavaScripts(t *testing.T) {
	nan := math.NaN()
	for _, c := range []struct {
		in    string
		radix int
		want  float64
	}{
		{"", 16, nan}, {" ", 10, nan}, {"\u00a0\u2028\ufeff\u3000 12", 10, 12},
		{"\u180e12", 10, nan}, {"\u200b12", 10, nan}, {"\u008512", 16, nan}, {"\x0012", 10, nan},
		{"-12", 10, -12}, {"+12", 10, 12}, {"- 12", 10, nan}, {"--12", 10, nan}, {"-", 16, nan}, {"+", 10, nan},
		{"0x1A", 16, 26}, {"0X1a", 16, 26}, {"0x", 16, nan}, {"-0x1f", 16, -31}, {" +0xff", 16, 255},
		{"0x1A", 10, 0}, {"0x1A", 0, 26}, {"0x10", 8, 0}, {"0b11", 2, 0}, {"0x0x1", 16, 0},
		{"12abc", 10, 12}, {"FFg", 16, 255}, {"ff", 15, nan}, {"zz", 36, 1295}, {"ZZ", 36, 1295},
		{"z", 35, nan}, {"19", 9, 1}, {"12", 2, 1}, {"1", 0, 1}, {"1.9", 10, 1}, {"1e3", 10, 1},
		{"1", 1, nan}, {"1", 37, nan}, {"1", -1, nan}, {"1", -16, nan}, {"0x1", 1, nan},
		{"\u0663", 10, nan}, {"\uff11", 10, nan}, {"é1", 16, nan}, {"00012", 10, 12},
		{"9007199254740993", 10, 9007199254740992},
		{"123456789012345678901234567890", 10, 1.2345678901234568e+29},
		{strings.Repeat("1", 400), 10, math.Inf(1)},
		{"-" + strings.Repeat("f", 300), 16, math.Inf(-1)},
		{"1" + strings.Repeat("0", 300), 16, math.Inf(1)},
		{strings.Repeat("0", 300) + "1", 16, 1},
		{"5ed8cd3b08cc9dc3ce9fa", 16, 7.166427752530308e+24},
		{"1uufadksf0hl6g8gb", 32, 2.378276947556157e+24},
		{"4117765555626147467665715", 8, 1.9627150406253187e+22},
		{"-0Xkbr2Afb4C9CEA69FD299z29cD", 35, -2.5553772363083416e+32},
		{"zzzzzzzzzzzzzzz", 36, 2.2107391972073336e+23},
		{"12121212121212121212121212", 3, 1588666142705},
	} {
		got := ParseIntRadix(c.in, c.radix)
		if math.Float64bits(got) != math.Float64bits(c.want) && !(math.IsNaN(got) && math.IsNaN(c.want)) {
			t.Errorf("parseInt(%q, %d) = %v, want %v", c.in, c.radix, got, c.want)
		}
	}
	if !math.Signbit(ParseIntRadix("-0", 16)) || !math.Signbit(ParseIntRadix("-0x0", 16)) {
		t.Error("parseInt('-0', 16) is -0")
	}
}

func TestNumberIsJavaScriptsNumber(t *testing.T) {
	cases := map[string]string{
		"": "0", "  ": "0", " 7 ": "7", "\uFEFF5": "5", "\u00855": "NaN", " 0x1F ": "31", "0b101": "5", "0o17": "15",
		"-0x10": "NaN", "0x": "NaN", "0x-1": "NaN", "1_000": "NaN", "1e1000": "Infinity", "-1e1000": "-Infinity",
		".5": "0.5", "5.": "5", "+.5e1": "5", "Infinity": "Infinity", "+Infinity": "Infinity", "-Infinity": "-Infinity",
		"Infinityx": "NaN", "infinity": "NaN", "1,5": "NaN", "12abc": "NaN", "--1": "NaN", "1e": "NaN",
	}
	for in, want := range cases {
		if got := NumberString(Number(in)); got != want {
			t.Errorf("Number(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestStringIsJavaScriptsString(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{nil, "null"}, {"s", "s"}, {true, "true"}, {json.Number("1.50"), "1.5"}, {json.Number("1e400"), "Infinity"},
		{json.Number("-0"), "0"}, {2.5, "2.5"}, {int64(-7), "-7"}, {3, "3"},
		{[]any{json.Number("1"), nil, "a", []any{"b", "c"}}, "1,,a,b,c"}, {NewObject(), "[object Object]"},
	}
	for _, c := range cases {
		if got := String(c.in); got != c.want {
			t.Errorf("String(%#v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTruthyIsJavaScripts(t *testing.T) {
	// 1e-400 underflows to 0 in JavaScript too.
	falsy := []any{nil, Undefined, false, "", json.Number("0"), json.Number("-0"), json.Number("0.0"), json.Number("1e-400"), 0.0, math.NaN(), int64(0), 0}
	truthy := []any{true, "0", " ", json.Number("0.1"), -1.0, int64(1), []any{}, NewObject()}
	for _, v := range falsy {
		if Truthy(v) {
			t.Errorf("%#v is falsy", v)
		}
	}
	for _, v := range truthy {
		if !Truthy(v) {
			t.Errorf("%#v is truthy", v)
		}
		if Or(v, "fallback") == "fallback" {
			t.Errorf("%#v || fallback is the fallback", v)
		}
	}
	for _, v := range falsy {
		if Or(v, Undefined) != Undefined {
			t.Errorf("%#v || undefined is not undefined", v)
		}
	}
}

// Google and Falco escape <, >, =, & and ' in their JSON; JSON.parse then
// JSON.stringify prints them as is, keeps key order and keeps false and zero.
func TestParseRoundTripsLikeJSONStringify(t *testing.T) {
	raw := `{"z":1,"a":{"bold":false,"n":0,"f":1.50,"e":1E2,"big":1e400,"neg":-0},"s":"a<b=&' \"\\\b\f\n\r\t\u0001\u007f\u2028é\u003c","arr":[],"obj":{},"nul":null,"z":2}`
	v, err := Parse([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	got, err := v.(*Object).MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	want := `{"z":2,"a":{"bold":false,"n":0,"f":1.5,"e":100,"big":null,"neg":0},"s":"a<b=&'` + " " + `\"\\\b\f\n\r\t\u0001` + "\u007f\u2028é<" + `","arr":[],"obj":{},"nul":null}`
	if string(got) != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
	// Indented by an encoder that does not escape HTML, as the host prints --json.
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(map[string]any{"v": v}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.String(), "\"s\": \"a<b=&' ") || !strings.Contains(b.String(), "\"arr\": [],") {
		t.Fatalf("%s", b.String())
	}
	obj := v.(*Object)
	if z, ok := obj.Get("z"); !ok || z != json.Number("2") {
		t.Fatalf("%v", z)
	}
	if _, ok := obj.Get("missing"); ok {
		t.Fatal("missing key present")
	}
	if n, ok := obj.Get("nul"); !ok || n != nil {
		t.Fatal("null is present, not undefined")
	}
	var nilObj *Object
	if _, ok := nilObj.Get("x"); ok || nilObj.Keys() != nil || nilObj.Text("x") != nil {
		t.Fatal("nil object has keys")
	}
	if string(Stringify(nilObj)) != "null" {
		t.Fatal("nil object is null")
	}
	for _, bad := range []string{`{"a":`, `{} {}`, `[1,]`, ``, `{"a" 1}`, `[1 2]`, `{1:2}`, `NaN`, `'a'`} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestDuplicateKeysKeepFirstPositionAndLastValue(t *testing.T) {
	o := mustObject(t, `{"b":1,"a":"<&>\u2028\u0001","b":2.50}`)
	if got := string(Stringify(o)); got != "{\"b\":2.5,\"a\":\"<&>\u2028\\u0001\"}" {
		t.Fatalf("%s", got)
	}
	keys := o.Keys()
	if strings.Join(keys, ",") != "b,a" {
		t.Fatalf("%q", keys)
	}
	// Keys is a copy: changing it does not reorder the object.
	keys[0] = "zzz"
	o.Set("c", nil)
	o.Set("b", true)
	if got := string(Stringify(o)); got != "{\"b\":true,\"a\":\"<&>\u2028\\u0001\",\"c\":null}" {
		t.Fatalf("%s", got)
	}
}

func TestObjectFieldAccessors(t *testing.T) {
	o := mustObject(t, `{"s":"x","n":12.0,"null":null,"f":false,"arr":[1,null,"a"],"o":{}}`)
	if s, ok := o.Str("s"); !ok || s != "x" {
		t.Fatal("string field")
	}
	for _, k := range []string{"n", "null", "f", "missing", "o"} {
		if _, ok := o.Str(k); ok {
			t.Errorf("%s read as a string", k)
		}
	}
	text := func(k string) string {
		p := o.Text(k)
		if p == nil {
			return "<nil>"
		}
		return *p
	}
	for k, want := range map[string]string{"s": "x", "n": "12", "null": "<nil>", "missing": "<nil>", "f": "false", "arr": "1,,a", "o": "[object Object]"} {
		if got := text(k); got != want {
			t.Errorf("text(%s) = %q, want %q", k, got, want)
		}
	}
}

type marshaler struct{}

func (marshaler) MarshalJSON() ([]byte, error) { return []byte(`{"html":"<&>"}`), nil }

func TestStringifyPlainGoValues(t *testing.T) {
	arr := []any{
		math.NaN(), math.Inf(1), math.Copysign(0, -1), 1e21, 1e-7, 3, int64(-4), json.Number("1e400"), json.Number("abc"),
		marshaler{}, map[string]int{"k": 1}, "é\U0001F600",
	}
	want := `[null,null,0,1e+21,1e-7,3,-4,null,null,{"html":"<&>"},{"k":1},"é` + "\U0001F600" + `"]`
	if got := string(Stringify(arr)); got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
	if Quote("a\"b\\c\x1f</script>") != `"a\"b\\c\u001f</script>"` {
		t.Fatal(Quote("a\"b\\c\x1f</script>"))
	}
	// Invalid UTF-8 becomes U+FFFD, as a JavaScript string could not hold it.
	if Quote("a\xffb") != "\"a\uFFFDb\"" {
		t.Fatal(Quote("a\xffb"))
	}
}

func TestStringifyIndentIsTwoSpaces(t *testing.T) {
	o := mustObject(t, `{"a":[],"b":{},"c":[1,{"d":"<"}]}`)
	want := "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    {\n      \"d\": \"<\"\n    }\n  ]\n}"
	if got := string(StringifyIndent(o)); got != want {
		t.Fatalf("\n got %s\nwant %s", got, want)
	}
	if string(StringifyIndent(NewObject())) != "{}" || string(StringifyIndent([]any{})) != "[]" || string(StringifyIndent("x")) != `"x"` {
		t.Fatal("empty containers")
	}
}

// Slice and Truncate count UTF-16 units like String.prototype.slice, so an
// emoji cut in half leaves a lone surrogate (U+FFFD once encoded).
func TestSliceAndTruncateCountUTF16Units(t *testing.T) {
	if Slice("a😀b", 2) != "a\uFFFD" || Slice("a😀b", 3) != "a😀" || Slice("abc", 10) != "abc" || Slice("abc", 0) != "" || Slice("", 3) != "" {
		t.Fatal("slice")
	}
	cases := map[string]string{
		"short":                       "short",
		"":                            "",
		strings.Repeat("a", 5):        strings.Repeat("a", 5),
		strings.Repeat("a", 6):        strings.Repeat("a", 5) + "...",
		strings.Repeat("é", 4) + "😀x": strings.Repeat("é", 4) + "\uFFFD...",
		"abc😀":                        "abc😀",
		"abcd😀":                       "abcd\uFFFD...",
		"😀😀😀":                         "😀😀\uFFFD...",
	}
	for in, want := range cases {
		if got := Truncate(in, 5); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestTrimUsesJavaScriptWhitespace(t *testing.T) {
	if Trim("\uFEFF\u00a0\u2029 x y\u3000\t") != "x y" || Trim("\u0085x\u0085") != "\u0085x\u0085" || Trim("\u180Ex") != "\u180Ex" {
		t.Fatal("trim")
	}
}

func TestDecodeUTF8IsTextDecoder(t *testing.T) {
	cases := map[string]string{
		"\xEF\xBB\xBFabc":          "abc",
		"\xEF\xBB\xBF\xEF\xBB\xBF": "\uFEFF",
		"a\xffb":                   "a\uFFFDb",
		"\xe2\x82":                 "\uFFFD\uFFFD",
		"é😀":                       "é😀",
		"":                         "",
	}
	for in, want := range cases {
		if got := DecodeUTF8([]byte(in)); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestURLEncodingIsJavaScripts(t *testing.T) {
	if EncodeURIComponent("a b/é!*'()~-_.?&=+%") != "a%20b%2F%C3%A9!*'()~-_.%3F%26%3D%2B%25" {
		t.Fatal(EncodeURIComponent("a b/é!*'()~-_.?&=+%"))
	}
	if formEscape("a b~*") != "a+b%7E*" {
		t.Fatal("formEscape")
	}
	q := NewSearchParams()
	q.Set("b", "1 2")
	q.Set("a&", "é")
	q.Set("b", "3")
	if q.String() != "b=3&a%26=%C3%A9" {
		t.Fatal(q.String())
	}
	if NewSearchParams().String() != "" {
		t.Fatal("empty params")
	}
}

func TestDecodeURIComponentThrowsWhereJavaScriptDoes(t *testing.T) {
	for in, want := range map[string]string{
		"plain":                  "plain",
		"a%20b%2F%C3%A9+%2b":     "a b/é++",
		"..%2F..%2Fetc%2Fpasswd": "../../etc/passwd",
		"%f0%9f%98%80":           "😀",
		"é%C3%A9":                "éé",
	} {
		if got, ok := DecodeURIComponent(in); !ok || got != want {
			t.Errorf("%q: got %q ok=%v, want %q", in, got, ok, want)
		}
	}
	// Each of these is a URIError in Bun.
	for _, in := range []string{"%", "%E0%A4%A", "%zz", "%C3", "%C3é", "%ED%A0%80", "%C0%AF", "%FF", "a%2"} {
		if got, ok := DecodeURIComponent(in); ok {
			t.Errorf("%q decoded to %q, want a URIError", in, got)
		}
	}
}

func TestLengthAndPadEndCountUTF16Units(t *testing.T) {
	if Length("a😀é") != 4 || Length("") != 0 {
		t.Fatal(Length("a😀é"))
	}
	if PadEnd("ab", 4) != "ab  " || PadEnd("😀", 4) != "😀  " || PadEnd("abcde", 4) != "abcde" {
		t.Fatalf("%q", PadEnd("😀", 4))
	}
}

func TestBufferStringKeepsTheBOMAndReplacesMaximalSubparts(t *testing.T) {
	cases := map[string]string{
		"\xe2\x82":                  "�",
		"\xe2\x82A":                 "�A",
		"\xed\xa0\x80":              "���",
		"\xf0\x9f\x98":              "�",
		"\xc0\xaf":                  "��",
		"\xf4\x90\x80\x80":          "����",
		"\xef\xbb\xbf\xef\xbb\xbfA": "\uFEFF\uFEFFA",
		"a\xffb":                    "a�b",
		"\xe0\x80A":                 "��A",
		"é😀":                        "é😀",
	}
	for in, want := range cases {
		if got := BufferString([]byte(in)); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestDecodeBase64IsBufferFrom(t *testing.T) {
	cases := map[string]string{
		"SGVsbG8-_w":          "Hello>\xff",
		"SGV sbG8=QQ==":       "Hello",
		"QUJD\nRA":            "ABCD",
		"Q":                   "",
		"":                    "",
		"4pyTIMOgIGxhIG1vZGU": "✓ à la mode",
	}
	for in, want := range cases {
		if got := string(DecodeBase64(in)); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestLocaleCompareSortsLikeBun(t *testing.T) {
	names := []string{"b", "A", "a", "B", "_x", "Z/y", "auto/receipts", "Auto", "école", "ecole", "Zebra", "zebra", "10", "9", "INBOX", "[Imap]/Sent", "label-1", "label_1", "Label 2", "CATEGORY_PERSONAL", "Category", "😀x", "Ärger", "Arger", "a b", "ab", "a-b"}
	want := []string{"_x", "[Imap]/Sent", "😀x", "10", "9", "a", "A", "a b", "a-b", "ab", "Arger", "Ärger", "Auto", "auto/receipts", "b", "B", "Category", "CATEGORY_PERSONAL", "ecole", "école", "INBOX", "Label 2", "label_1", "label-1", "Z/y", "zebra", "Zebra"}
	sort.SliceStable(names, func(i, j int) bool { return LocaleCompare(names[i], names[j]) < 0 })
	if strings.Join(names, "|") != strings.Join(want, "|") {
		t.Fatalf("got  %q\nwant %q", names, want)
	}
	if LocaleCompare("a", "A") != -1 || LocaleCompare("A", "a") != 1 || LocaleCompare("a", "a") != 0 {
		t.Fatal("case order")
	}
}

func TestParseErrorMessageIsJavaScriptCores(t *testing.T) {
	cases := map[string]string{
		"":          "Unexpected EOF",
		" ":         "Unexpected EOF",
		"{":         "Expected '}'",
		`{"a":1,}`:  "Property name must be a string literal",
		"x":         `Unexpected identifier "x"`,
		"[1":        "Expected ']'",
		`{"a":1} x`: "Unable to parse JSON string",
		"tru":       `Unexpected identifier "tru"`,
		`"abc`:      "Unterminated string",
		`{"a" 1}`:   "Expected ':' before value in object property definition",
		"12a":       "Unable to parse JSON string",
		`{"a":01}`:  "Expected '}'",
		"nul":       `Unexpected identifier "nul"`,
		"{}}":       "Unable to parse JSON string",
		"é":         "Unrecognized token 'é'",
		"[":         "Unexpected EOF",
		"[1,":       "Unexpected EOF",
		"[[1,":      "Unexpected EOF",
		`{"a":`:     "Unexpected EOF",
		`{"a":1,`:   "Property name must be a string literal",
		"{ ":        "Expected '}'",
		"[1,]":      "Unexpected comma at the end of array expression",
		"[1,,2]":    "Unexpected token ','",
		"]":         "Unexpected token ']'",
		"[}":        "Unexpected token '}'",
		`{"a":,}`:   "Unexpected token ','",
		"[1 2]":     "Expected ']'",
		"{bad":      "Expected '}'",
		"{1}":       "Expected '}'",
		"{,":        "Expected '}'",
		`{"a":1,1`:  "Property name must be a string literal",
	}
	for in, want := range cases {
		if got := ParseErrorMessage([]byte(in)); got != "JSON Parse error: "+want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestParseDateIsBunsNewDate(t *testing.T) {
	la, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		t.Skip("no tzdata")
	}
	prev := time.Local
	time.Local = la
	t.Cleanup(func() { time.Local = prev })
	// Each pair is what `TZ=America/Los_Angeles bun -e 'new Date(s).toISOString()'` prints.
	for in, want := range map[string]string{
		"2026-04-01":                               "2026-04-01T00:00:00.000Z",
		"2026-04":                                  "2026-04-01T00:00:00.000Z",
		"2026":                                     "2026-01-01T00:00:00.000Z",
		"2026-04Z":                                 "2026-04-01T00:00:00.000Z",
		"+002026-04-01":                            "2026-04-01T00:00:00.000Z",
		"2026-04-01T10:00":                         "2026-04-01T17:00:00.000Z",
		"2026-04-01t10:00Z":                        "2026-04-01T10:00:00.000Z",
		"2026-04-01 10:00":                         "2026-04-01T17:00:00.000Z",
		"2026-04-01T10:00:00.5":                    "2026-04-01T17:00:00.500Z",
		"2026-04-01T10:00:05.1234Z":                "2026-04-01T10:00:05.123Z",
		"2026-04-01T10:00:00-0530":                 "2026-04-01T15:30:00.000Z",
		"2026-04-01T10:00+0100":                    "2026-04-01T09:00:00.000Z",
		"2026-04-01 10:00:00+02:00":                "2026-04-01T08:00:00.000Z",
		"2026-04-01T24:00":                         "2026-04-02T07:00:00.000Z",
		"2026-04-01T24:00:00.000Z":                 "2026-04-02T00:00:00.000Z",
		"2024-02-29":                               "2024-02-29T00:00:00.000Z",
		"2026-02-29":                               "2026-03-01T00:00:00.000Z",
		"2026-02-30":                               "2026-03-02T00:00:00.000Z",
		"2026-04-31":                               "2026-05-01T00:00:00.000Z",
		" 2026-04-01 ":                             "2026-04-01T07:00:00.000Z",
		"2026-4-1":                                 "2026-04-01T07:00:00.000Z",
		"2026/04/01":                               "2026-04-01T07:00:00.000Z",
		"2026/04/01 10:00":                         "2026-04-01T17:00:00.000Z",
		"04/01/2026":                               "2026-04-01T07:00:00.000Z",
		"1/2/2026":                                 "2026-01-02T08:00:00.000Z",
		"02/30/2026":                               "2026-03-02T08:00:00.000Z",
		"2026-04-01T10:00:00.123456789Z":           "2026-04-01T10:00:00.123Z",
		"Tue, 10 Jun 2025 04:00:00 GMT":            "2025-06-10T04:00:00.000Z",
		"Tue, 10 Jun 2025 04:00:00 +0200":          "2025-06-10T02:00:00.000Z",
		"Tue, 10 Jun 2025 04:00:00 EST":            "2025-06-10T09:00:00.000Z",
		"Tue, 10 Jun 2025 04:00:00":                "2025-06-10T11:00:00.000Z",
		"Tue, 10 Jun 25 04:00:00 GMT":              "2025-06-10T04:00:00.000Z",
		"Tue, 10 Jun 75 04:00:00 GMT":              "1975-06-10T04:00:00.000Z",
		"Tuesday, 10-Jun-25 04:00:00 GMT":          "2025-06-10T04:00:00.000Z",
		"Tue Jun 10 2025 04:00:00 GMT+0200 (CEST)": "2025-06-10T02:00:00.000Z",
		"Tue Jun 10 04:00:00 GMT 2025":             "2025-06-10T04:00:00.000Z",
		"Tue, 10 Jun 2025 04:00:00 +02:00":         "2025-06-10T02:00:00.000Z",
		"Tue, 10 Jun 2025 04:00:00 GMT+2":          "2025-06-10T02:00:00.000Z",
		"Tue, 31 Jun 2025 04:00:00 GMT":            "2025-07-01T04:00:00.000Z",
		"June 10, 2025 4:00 PM":                    "2025-06-10T23:00:00.000Z",
		"Mon, 01 Jan 2024 10:00:00.123 GMT":        "2024-01-01T10:00:00.123Z",
		"Mon, 01 Jan 2024 10 GMT":                  "2024-01-01T00:00:00.000Z",
		"12:00 Jan 1 2024":                         "2024-01-01T20:00:00.000Z",
		"2025-06-10 04:00:00Z":                     "2025-06-10T04:00:00.000Z",
		"January 2024":                             "2024-01-01T08:00:00.000Z",
		"Jan 1":                                    "2001-01-01T08:00:00.000Z",
		"Jan 1 49":                                 "2049-01-01T08:00:00.000Z",
		"Jan 1 50":                                 "1950-01-01T08:00:00.000Z",
		"Jan 1 100":                                "0100-01-01T07:52:58.000Z",
		"Jan 1 10000":                              "+010000-01-01T08:00:00.000Z",
		"-2024-01-01":                              "2024-01-01T08:00:00.000Z",
		"Sat, 13 Sep 275760 00:00:00 GMT":          "+275760-09-13T00:00:00.000Z",
		"Sun, 10 Mar 2024 02:30:00":                "2024-03-10T10:30:00.000Z",
		"Sun, 03 Nov 2024 01:30:00":                "2024-11-03T08:30:00.000Z",
	} {
		got, ok := ParseDate(in)
		if !ok || ISOString(got) != want {
			t.Errorf("%q: %v %s", in, ok, ISOString(got))
		}
	}
	for _, in := range []string{"", "yesterday", "2026-13-01", "2026-00-10", "2026-04-32", "2026-04-01T25:00", "2026-04-01T24:30",
		"2026-04-01T24:00:01", "2026-04-01T23:60", "2026-04-01T10:00:60", "2026-04-01T10", "2026-04-01T10:00+01",
		"2026-04-01T10:00:00.", "2026/4/32", "13/01/2026",
		"Tue, 10 Jun 2025 04:00:00 CET", "Tue, 32 Jun 2025 04:00:00 GMT", " 2025-06-10T04:00:00Z ", "20240101",
		"2024-01-01T00:00:00+24:00", "Mon, 01 Jan 2024 10:00:00 +99999", "Sat, 14 Sep 275760 00:00:00 GMT"} {
		if _, ok := ParseDate(in); ok {
			t.Errorf("%q parsed", in)
		}
	}
}

func TestISOStringIsUTCWithTruncatedMilliseconds(t *testing.T) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 999_999_999, time.FixedZone("", -5*3600))
	if got := ISOString(at); got != "2026-01-02T08:04:05.999Z" {
		t.Fatal(got)
	}
	if got := ISOString(time.Date(1999, 12, 31, 23, 59, 59, 0, time.UTC)); got != "1999-12-31T23:59:59.000Z" {
		t.Fatal(got)
	}
}

// Plain Go maps, slices and structs are written as JSON.stringify writes the
// same values: no escaping of <, > and &, U+2028 and U+2029 as is, and
// String(n) number text. The want strings are JSON.stringify output from Bun
// (map keys given in sorted order, since a Go map is written sorted).
func TestStringifyPlainGoContainersMatchJSONStringify(t *testing.T) {
	negZero := math.Copysign(0, -1)
	cases := []struct {
		name string
		v    any
		want string
	}{
		{"nested maps", map[string]any{
			"a": "\u2028\u2029\u0007",
			"b": map[string]any{"x": nil, "y": []any{1, map[string]string{"q": `<a href="x">&amp;</a>`}}},
		}, "{\"a\":\"\u2028\u2029\\u0007\",\"b\":{\"x\":null,\"y\":[1,{\"q\":\"<a href=\\\"x\\\">&amp;</a>\"}]}}"},
		{"floats", []float64{1e21, 1e-7, negZero, 0.1, 1.5, 123456789012345680000, 1e-6, -1e21, 5e-324, math.NaN(), math.Inf(1), math.Inf(-1)},
			`[1e+21,1e-7,0,0.1,1.5,123456789012345680000,0.000001,-1e+21,5e-324,null,null,null]`},
		{"floats in a map", map[string]float64{"a": 1e21, "b": 1e-7, "c": negZero, "d": math.NaN()}, `{"a":1e+21,"b":1e-7,"c":0,"d":null}`},
		{"json.Number", []json.Number{"12345678901234567890", "1.50", "1E3", "-0.0"}, `[12345678901234567000,1.5,1000,0]`},
		{"slice of maps", []map[string]any{{"a": 2, "z": "<&>"}, {}}, `[{"a":2,"z":"<&>"},{}]`},
		{"slice of strings", []string{"<b>", "\u2029"}, "[\"<b>\",\"\u2029\"]"},
		{"array", [2]any{nil, true}, `[null,true]`},
		{"integers are JavaScript numbers", []any{int8(-8), uint16(7), int32(1 << 30), uint64(math.MaxUint64), int64(math.MaxInt64), int64(1 << 53), float32(0.1)},
			`[-8,7,1073741824,18446744073709552000,9223372036854776000,9007199254740992,0.1]`},
		{"nil", nil, `null`},
		{"nil values inside", map[string]any{"m": map[string]any(nil), "p": (*int)(nil), "s": []string(nil), "i": nil}, `{"i":null,"m":null,"p":null,"s":null}`},
		{"pointer and interface", []any{ptr(2.5), any(map[string]any{"k": ptr("<")})}, `[2.5,{"k":"<"}]`},
		{"named string key", map[label]int{"b": 1, "a": 2}, `{"a":2,"b":1}`},
		{"*Object inside a map keeps its order", map[string]any{"o": ordered("z", 1, "a", "<&>")}, `{"o":{"z":1,"a":"<&>"}}`},
	}
	for _, c := range cases {
		if got := string(Stringify(c.v)); got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

// A Go map has no insertion order: its keys are written sorted, whatever the
// order the literal names them in.
func TestStringifyWritesGoMapKeysSorted(t *testing.T) {
	m := map[string]any{"zeta": 1, "alpha": 2, "Mid": 3, "beta": map[string]any{"y": 1, "x": 2}}
	for i := 0; i < 20; i++ { // map iteration order is random: every run must agree
		if got := string(Stringify(m)); got != `{"Mid":3,"alpha":2,"beta":{"x":2,"y":1},"zeta":1}` {
			t.Fatalf("run %d: %s", i, got)
		}
	}
}

type label string

type receipt struct {
	Name    string         `json:"name"`
	Size    float64        `json:"size"`
	Skip    string         `json:"-"`
	Note    string         `json:"note,omitempty"`
	Extra   map[string]any `json:"extra"`
	Nested  *receipt       `json:"nested,omitempty"`
	private string
}

// A struct keeps its declaration order and json tags, with JSON.stringify's
// strings and numbers; a struct encoding/json cannot write is null.
func TestStringifyStructs(t *testing.T) {
	r := receipt{
		Name: "<a&b>\u2028", Size: 1e21, Skip: "no", Extra: map[string]any{"b": 1e-7, "a": -0.0},
		Nested: &receipt{Name: "inner", Size: 1.50}, private: "x",
	}
	want := "{\"name\":\"<a&b>\u2028\",\"size\":1e+21,\"extra\":{\"a\":0,\"b\":1e-7},\"nested\":{\"name\":\"inner\",\"size\":1.5,\"extra\":null}}"
	if got := string(Stringify(r)); got != want {
		t.Errorf("value:\n got %s\nwant %s", got, want)
	}
	if got := string(Stringify(&r)); got != want {
		t.Errorf("pointer:\n got %s\nwant %s", got, want)
	}
	if got := string(Stringify([]receipt{{Name: "&"}})); got != `[{"name":"&","size":0,"extra":null}]` {
		t.Errorf("slice: %s", got)
	}
	if got := string(Stringify(receipt{Size: math.NaN()})); got != "null" {
		t.Errorf("NaN field: %s", got)
	}
	if got := string(Stringify([]byte{1, 2})); got != `"AQI="` {
		t.Errorf("[]byte: %s", got)
	}
	indented := string(StringifyIndent(map[string]any{"a": []any{"<\u2028>"}}))
	if indented != "{\n  \"a\": [\n    \"<\u2028>\"\n  ]\n}" {
		t.Errorf("indent: %q", indented)
	}
}

func ptr[T any](v T) *T { return &v }

func ordered(kv ...any) *Object {
	o := NewObject()
	for i := 0; i < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

func TestRandomUUIDIsVersion4(t *testing.T) {
	shape := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	a, b := RandomUUID(), RandomUUID()
	if !shape.MatchString(a) || !shape.MatchString(b) || a == b {
		t.Fatalf("%q %q", a, b)
	}
}
