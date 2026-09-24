package sql

import (
	"encoding/hex"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// This file is Bun.SQL's PostgreSQL DataCell for the text format, which is
// what the simple query protocol behind sql.unsafe(query) returns.

// PostgreSQL type OIDs Bun.SQL decodes (bun src/sql/postgres/types/Tag.rs).
const (
	oidBool        = 16
	oidBytea       = 17
	oidChar        = 18
	oidName        = 19
	oidInt8        = 20
	oidInt2        = 21
	oidInt2vector  = 22
	oidInt4        = 23
	oidText        = 25
	oidOid         = 26
	oidXid         = 28
	oidCid         = 29
	oidJSON        = 114
	oidXMLArray    = 143
	oidJSONArray   = 199
	oidLineArray   = 629
	oidCidrArray   = 651
	oidFloat4      = 700
	oidFloat8      = 701
	oidCircleArray = 719
	oidMacaddr8Arr = 775
	oidMoneyArray  = 791
	oidBoolArray   = 1000
	oidByteaArray  = 1001
	oidCharArray   = 1002
	oidNameArray   = 1003
	oidInt2Array   = 1005
	oidInt2vecArr  = 1006
	oidInt4Array   = 1007
	oidTextArray   = 1009
	oidTidArray    = 1010
	oidXidArray    = 1011
	oidCidArray    = 1012
	oidBpcharArray = 1014
	oidVarcharArr  = 1015
	oidInt8Array   = 1016
	oidPointArray  = 1017
	oidLsegArray   = 1018
	oidPathArray   = 1019
	oidBoxArray    = 1020
	oidFloat4Array = 1021
	oidFloat8Array = 1022
	oidPolygonArr  = 1027
	oidOidArray    = 1028
	oidAclitemArr  = 1034
	oidMacaddrArr  = 1040
	oidInetArray   = 1041
	oidDate        = 1082
	oidTime        = 1083
	oidTimestamp   = 1114
	oidTimestampA  = 1115
	oidDateArray   = 1182
	oidTimeArray   = 1183
	oidTimestamptz = 1184
	oidTstzArray   = 1185
	oidIntervalArr = 1187
	oidNumericArr  = 1231
	oidTimetz      = 1266
	oidTimetzArray = 1270
	oidBitArray    = 1561
	oidVarbitArray = 1563
	oidNumeric     = 1700
	oidJSONB       = 3802
	oidJSONBArray  = 3807
	oidPgDbArray2  = 10052
	oidPgDbArray   = 12052
)

// errDecode is AnyPostgresError raised while decoding a row; Bun reports it
// as "Failed to bind query: <name>".
type errDecode string

func (e errDecode) Error() string { return "Failed to bind query: " + string(e) }

const (
	errArrayFormat  = errDecode("UnsupportedArrayFormat")
	errByteSequence = errDecode("InvalidByteSequence")
	errByteaFormat  = errDecode("UnsupportedByteaFormat")
)

// jsonParseError is the SyntaxError JSON.parse throws for a json column.
type jsonParseError struct{ message string }

func (e jsonParseError) Error() string { return e.message }

// decodePostgresText is from_bytes(binary = false) for one non-NULL value.
func decodePostgresText(oid uint32, b []byte) (any, error) {
	if oid > math.MaxInt16 {
		oid = oidText
	}
	switch oid {
	case oidInt2, oidInt4:
		n, err := strconv.ParseInt(string(b), 10, 32)
		if err != nil {
			n = 0
		}
		return float64(n), nil
	case oidOid, oidXid, oidCid:
		n, err := strconv.ParseUint(string(b), 10, 32)
		if err != nil {
			n = 0
		}
		return float64(n), nil
	case oidInt8, oidNumeric:
		// Strings, so no digit is lost.
		return jsvalue.BufferString(b), nil
	case oidFloat4, oidFloat8:
		return parseFloat(b), nil
	case oidJSON, oidJSONB:
		return parseJSONCell(b)
	case oidBool:
		return len(b) > 0 && b[0] == 't', nil
	case oidDate, oidTimestamp, oidTimestamptz:
		if len(b) == 0 || strings.EqualFold(string(b), "NULL") {
			return nil, nil
		}
		if inf, ok := parseInfinity(b); ok {
			// ±Infinity is returned as a Number, not a Date.
			return inf, nil
		}
		return jsDate(parseDateTimeText(oid, b)), nil
	case oidTime, oidTimetz:
		if len(b) == 0 {
			return nil, nil
		}
		return jsvalue.BufferString(b), nil
	case oidBytea:
		if strings.HasPrefix(string(b), `\x`) {
			return parseBytea(b[2:])
		}
		return nil, errByteaFormat
	case oidBpcharArray, oidVarcharArr, oidCharArray, oidTextArray, oidNameArray,
		oidJSONArray, oidJSONBArray, oidPathArray, oidXMLArray, oidPointArray,
		oidLsegArray, oidBoxArray, oidPolygonArr, oidLineArray, oidCidrArray,
		oidNumericArr, oidMoneyArray, oidVarbitArray, oidBitArray, oidInt2vecArr,
		oidCircleArray, oidMacaddr8Arr, oidMacaddrArr, oidInetArray, oidAclitemArr,
		oidTidArray, oidPgDbArray, oidPgDbArray2, oidInt8Array, oidInt2Array,
		oidFloat8Array, oidOidArray, oidXidArray, oidCidArray, oidBoolArray,
		oidByteaArray, oidTimeArray, oidDateArray, oidTimetzArray, oidTimestampA,
		oidTstzArray, oidIntervalArr, oidInt4Array, oidFloat4Array:
		v, _, err := parseArray(b, oid, false, 0)
		return v, err
	}
	return jsvalue.BufferString(b), nil
}

// parseFloat is parse_f64: NaN when the text is not a number.
func parseFloat(b []byte) float64 {
	f, err := strconv.ParseFloat(string(b), 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

func parseJSONCell(b []byte) (any, error) {
	v, err := jsvalue.Parse(b)
	if err != nil {
		return nil, jsonParseError{jsvalue.ParseErrorMessage(b)}
	}
	return v, nil
}

func parseInfinity(b []byte) (float64, bool) {
	switch strings.ToLower(string(b)) {
	case "infinity":
		return math.Inf(1), true
	case "-infinity":
		return math.Inf(-1), true
	}
	return 0, false
}

func parseBytea(hexText []byte) (any, error) {
	out := make([]byte, len(hexText)/2)
	if _, err := hex.Decode(out, hexText[:len(out)*2]); err != nil {
		return nil, errByteSequence
	}
	return jsBuffer(out), nil
}

// dateTimeText is the wall clock of "YYYY-MM-DD[ |T]HH:MM:SS[.ffffff]"
// (bun src/sql_jsc/shared/datetime_text.rs).
type dateTimeText struct {
	year, month, day, hour, minute, second, microsecond int
}

func parseDigits(b []byte) (int, bool) {
	if len(b) == 0 {
		return 0, false
	}
	n := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	return n, true
}

// parseWallClock returns the components and how many bytes they used.
// timeRequired rejects the date-only form; allowT accepts 'T' as separator.
func parseWallClock(text []byte, timeRequired, allowT bool) (dateTimeText, int, bool) {
	var dt dateTimeText
	if len(text) < 10 || text[4] != '-' || text[7] != '-' {
		return dt, 0, false
	}
	var ok1, ok2, ok3 bool
	dt.year, ok1 = parseDigits(text[0:4])
	dt.month, ok2 = parseDigits(text[5:7])
	dt.day, ok3 = parseDigits(text[8:10])
	if !ok1 || !ok2 || !ok3 {
		return dt, 0, false
	}
	if len(text) == 10 {
		return dt, 10, !timeRequired
	}
	sep := text[10] == ' ' || allowT && text[10] == 'T'
	if len(text) < 19 || !sep || text[13] != ':' || text[16] != ':' {
		return dt, 0, false
	}
	dt.hour, ok1 = parseDigits(text[11:13])
	dt.minute, ok2 = parseDigits(text[14:16])
	dt.second, ok3 = parseDigits(text[17:19])
	if !ok1 || !ok2 || !ok3 {
		return dt, 0, false
	}
	if len(text) == 19 || text[19] != '.' {
		return dt, 19, true
	}
	frac := 0
	for 20+frac < len(text) && text[20+frac] >= '0' && text[20+frac] <= '9' {
		frac++
	}
	if frac == 0 || frac > 6 {
		return dt, 0, false
	}
	micro, _ := parseDigits(text[20 : 20+frac])
	for i := frac; i < 6; i++ {
		micro *= 10
	}
	dt.microsecond = micro
	return dt, 20 + frac, true
}

// msUTC is gregorian_date_time_to_ms_utc: the wall clock read as UTC.
func (dt dateTimeText) msUTC() float64 {
	t := time.Date(dt.year, time.Month(dt.month), dt.day, dt.hour, dt.minute, dt.second, 0, time.UTC)
	return float64(t.UnixMilli()) + float64(dt.microsecond/1000)
}

// parseDateTimeText is parse_date_time_text: timestamp read as UTC,
// timestamptz with its offset, anything else through Date.parse.
func parseDateTimeText(oid uint32, b []byte) float64 {
	switch oid {
	case oidTimestamp, oidTimestampA:
		if dt, n, ok := parseWallClock(b, true, false); ok && n == len(b) {
			return dt.msUTC()
		}
	case oidTimestamptz, oidTstzArray:
		if dt, n, ok := parseWallClock(b, true, false); ok {
			if offset, ok := parseOffset(b[n:]); ok {
				return dt.msUTC() - float64(offset)*1000
			}
		}
	}
	if t, ok := jsvalue.ParseDate(jsvalue.BufferString(b)); ok {
		return float64(t.UnixMilli())
	}
	return math.NaN()
}

// parseOffset is a timestamptz "±HH[:MM[:SS]]" suffix in seconds east of UTC.
func parseOffset(b []byte) (int, bool) {
	if len(b) < 3 || (b[0] != '+' && b[0] != '-') {
		return 0, false
	}
	sign := 1
	if b[0] == '-' {
		sign = -1
	}
	o := b[1:]
	hours, ok := parseDigits(o[0:2])
	if !ok {
		return 0, false
	}
	minutes, seconds := 0, 0
	switch {
	case len(o) == 2:
	case len(o) == 5 && o[2] == ':':
		if minutes, ok = parseDigits(o[3:5]); !ok {
			return 0, false
		}
	case len(o) == 8 && o[2] == ':' && o[5] == ':':
		if minutes, ok = parseDigits(o[3:5]); !ok {
			return 0, false
		}
		if seconds, ok = parseDigits(o[6:8]); !ok {
			return 0, false
		}
	default:
		return 0, false
	}
	if minutes > 59 || seconds > 59 {
		return 0, false
	}
	return sign * (hours*3600 + minutes*60 + seconds), true
}

// unescapeArrayString is unescape_postgres_string.
func unescapeArrayString(in []byte) ([]byte, bool) {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); i++ {
		if in[i] != '\\' || i+1 >= len(in) {
			out = append(out, in[i])
			continue
		}
		i++
		switch in[i] {
		case 'b':
			out = append(out, 0x08)
		case 'f':
			out = append(out, 0x0c)
		case 'n':
			out = append(out, '\n')
		case 'r':
			out = append(out, '\r')
		case 't':
			out = append(out, '\t')
		case '"', '\\', '\'', '/':
			out = append(out, in[i])
		case 'x':
			if i+2 >= len(in) {
				return nil, false
			}
			v, err := strconv.ParseUint(string(in[i+1:i+3]), 16, 8)
			if err != nil {
				return nil, false
			}
			out = append(out, byte(v))
			i += 2
		default:
			return nil, false
		}
	}
	return out, true
}

func isDateArray(oid uint32) bool {
	return oid == oidDateArray || oid == oidTimestampA || oid == oidTstzArray
}

func isJSONArray(oid uint32) bool { return oid == oidJSONArray || oid == oidJSONBArray }

// isTextArray is the parse_array element list read as bare words.
func isTextArray(oid uint32) bool {
	switch oid {
	case oidTimetzArray, oidDateArray, oidTimeArray, oidIntervalArr,
		oidBpcharArray, oidVarcharArr, oidCharArray, oidTextArray, oidNameArray,
		oidNumericArr, oidMoneyArray, oidVarbitArray, oidInt2vecArr, oidBitArray,
		oidPathArray, oidXMLArray, oidPointArray, oidLsegArray, oidBoxArray,
		oidPolygonArr, oidLineArray, oidCidrArray, oidCircleArray, oidMacaddr8Arr,
		oidMacaddrArr, oidInetArray, oidAclitemArr, oidPgDbArray, oidPgDbArray2:
		return true
	}
	return false
}

// parseArray is parse_array: the array literal at the start of b and how many
// bytes it used.
func parseArray(b []byte, oid uint32, jsonSub bool, depth int) ([]any, int, error) {
	if depth > 100 {
		return nil, 0, errArrayFormat
	}
	closing, opening := byte('}'), byte('{')
	if jsonSub {
		closing, opening = ']', '['
	}
	if len(b) < 2 || b[0] != opening {
		return nil, 0, errArrayFormat
	}
	if len(b) == 2 && b[1] == closing {
		return []any{}, 2, nil
	}
	separator := byte(',')
	if oid == oidBoxArray {
		separator = ';'
	}
	advance := func(s []byte, n int) []byte {
		if len(s) <= n {
			return nil
		}
		return s[n:]
	}
	array := []any{}
	slice := b[1:]
	reachedEnd := false
	for len(slice) > 0 {
		ch := slice[0]
		switch {
		case ch == closing:
			if reachedEnd {
				return nil, 0, errArrayFormat
			}
			reachedEnd = true
			slice = advance(slice, 1)
		case ch == opening:
			sub, used, err := parseArray(slice, oid, jsonSub, depth+1)
			if err != nil {
				return nil, 0, err
			}
			array = append(array, sub)
			slice = advance(slice, used)
			continue
		case ch == '"':
			end := 0
			escaped := false
			for i, c := range slice[1:] {
				if c == '"' && !escaped {
					end = i + 1
					break
				}
				escaped = !escaped && c == '\\'
			}
			if end == 0 {
				return nil, 0, errArrayFormat
			}
			element := slice[1:end]
			switch {
			case oid == oidByteaArray:
				if !strings.HasPrefix(string(element), `\\x`) {
					return nil, 0, errByteaFormat
				}
				v, err := parseBytea(element[3:])
				if err != nil {
					return nil, 0, err
				}
				array = append(array, v)
			case isDateArray(oid):
				array = append(array, jsDate(parseDateTimeText(oid, element)))
			case isJSONArray(oid):
				unescaped, ok := unescapeArrayString(element)
				if !ok {
					return nil, 0, errByteSequence
				}
				v, err := parseJSONCell(unescaped)
				if err != nil {
					return nil, 0, err
				}
				array = append(array, v)
			default:
				unescaped, ok := unescapeArrayString(element)
				if !ok {
					return nil, 0, errByteSequence
				}
				array = append(array, jsvalue.BufferString(unescaped))
			}
			slice = advance(slice, end+1)
			continue
		case ch == separator:
			slice = advance(slice, 1)
			continue
		case isTextArray(oid):
			end := 0
			for i, c := range slice {
				if c == '}' || c == separator {
					end = i
					break
				}
			}
			if end == 0 {
				return nil, 0, errArrayFormat
			}
			element := slice[:end]
			switch {
			case string(element) == "NULL":
				array = append(array, nil)
			case oid == oidDateArray:
				if inf, ok := parseInfinity(element); ok {
					array = append(array, jsDate(inf))
				} else {
					array = append(array, jsDate(parseDateTimeText(oid, element)))
				}
			case string(element) == `\b`:
				array = append(array, "\b")
			default:
				array = append(array, jsvalue.BufferString(element))
			}
			slice = advance(slice, end)
			continue
		default:
			v, used, err := parseArrayWord(slice, oid, closing, separator, depth)
			if err != nil {
				return nil, 0, err
			}
			if used < 0 {
				// "+" is skipped.
				slice = advance(slice, 1)
				continue
			}
			array = append(array, v)
			slice = advance(slice, used)
			continue
		}
		if reachedEnd {
			break
		}
	}
	if !reachedEnd {
		return nil, 0, errArrayFormat
	}
	return array, len(b) - len(slice), nil
}

// parseArrayWord is one unquoted element of a non-text array: NULL, NaN,
// booleans, Infinity, numbers, or a nested JSON array. used is -1 for a
// leading "+", which Bun skips.
func parseArrayWord(slice []byte, oid uint32, closing, separator byte, depth int) (any, int, error) {
	infinity := func(sign float64) any {
		if isDateArray(oid) {
			return jsDate(math.Inf(int(sign)))
		}
		return math.Inf(int(sign))
	}
	switch c := slice[0]; {
	case c == 'N':
		if len(slice) < 3 {
			return nil, 0, errArrayFormat
		}
		if len(slice) >= 4 && string(slice[:4]) == "NULL" {
			return nil, 4, nil
		}
		if string(slice[:3]) == "NaN" {
			return math.NaN(), 3, nil
		}
		return nil, 0, errArrayFormat
	case c == 'f':
		if isJSONArray(oid) {
			if len(slice) >= 5 && string(slice[:5]) == "false" {
				return false, 5, nil
			}
			return nil, 0, errArrayFormat
		}
		return false, 1, nil
	case c == 't':
		if isJSONArray(oid) {
			if len(slice) >= 4 && string(slice[:4]) == "true" {
				return true, 4, nil
			}
			return nil, 0, errArrayFormat
		}
		return true, 1, nil
	case c == 'I' || c == 'i':
		if len(slice) >= 8 && strings.EqualFold(string(slice[:8]), "infinity") {
			return infinity(1), 8, nil
		}
		return nil, 0, errArrayFormat
	case c == '+':
		return nil, -1, nil
	case c == '-' || c >= '0' && c <= '9':
		negative, float, exponent, minus, plus := false, false, false, false, false
		end := 0
		for i, b := range slice {
			switch {
			case b >= '0' && b <= '9':
				continue
			case b == closing || b == separator:
				end = i
			case b == 'e':
				if !float || exponent {
					return nil, 0, errArrayFormat
				}
				exponent = true
				continue
			case b == '+':
				if !exponent || plus {
					return nil, 0, errArrayFormat
				}
				plus = true
				continue
			case b == '-':
				if i == 0 {
					negative = true
					continue
				}
				if !exponent || minus {
					return nil, 0, errArrayFormat
				}
				minus = true
				continue
			case b == '.':
				if float {
					return nil, 0, errArrayFormat
				}
				float = true
				continue
			case b == 'I' || b == 'i':
				rest := slice
				sign := 1.0
				if negative {
					rest, sign = slice[1:], -1
				}
				if len(rest) >= 8 && strings.EqualFold(string(rest[:8]), "infinity") {
					n := 8
					if negative {
						n++
					}
					return infinity(sign), n, nil
				}
				return nil, 0, errArrayFormat
			default:
				return nil, 0, errArrayFormat
			}
			break
		}
		if end == 0 {
			return nil, 0, errArrayFormat
		}
		element := slice[:end]
		if float || oid == oidFloat8Array {
			return parseFloat(element), end, nil
		}
		switch oid {
		case oidInt8Array:
			return string(element), end, nil
		case oidCidArray, oidXidArray, oidOidArray:
			n, err := strconv.ParseUint(string(element), 10, 32)
			if err != nil {
				n = 0
			}
			return float64(n), end, nil
		}
		n, err := strconv.ParseInt(string(element), 10, 32)
		if err != nil {
			return nil, 0, errArrayFormat
		}
		return float64(n), end, nil
	default:
		if isJSONArray(oid) && c == '[' {
			sub, used, err := parseArray(slice, oid, true, depth+1)
			if err != nil {
				return nil, 0, err
			}
			return sub, used, nil
		}
		return nil, 0, errArrayFormat
	}
}
