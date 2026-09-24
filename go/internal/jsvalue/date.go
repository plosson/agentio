package jsvalue

import (
	"fmt"
	"math"
	"time"
)

// ParseDate is new Date(s) as Bun evaluates it: V8's DateParser. It first
// reads the ES5 ISO form ([+-yy]yyyy[-MM[-DD]][THH:mm[:ss[.sss]][Z|+hh:mm]],
// a date alone is UTC, a time without a zone is local), then falls back to
// the legacy form ("Tue, 10 Jun 2025 04:00:00 GMT", "June 10, 2025",
// "2025/06/10 4:00 PM", ...), which is local time unless a zone is given.
// A day past the month's end rolls over (Jun 31 is Jul 1). The result is in
// UTC with millisecond precision; false is an Invalid Date.
func ParseDate(s string) (time.Time, bool) {
	in := []rune(s)
	sc := &dateScanner{in: in}
	sc.next = sc.scan()
	var day dayComposer
	var tod timeComposer
	tz := tzComposer{sign: none, hour: none, minute: none}
	tod.hourOffset = none

	tok := parseES5(sc, &day, &tod, &tz)
	if tok.kind == tokInvalid {
		return time.Time{}, false
	}
	hasReadNumber := day.index > 0
	for ; tok.kind != tokEnd; tok = sc.advance() {
		switch {
		case tok.kind == tokNumber:
			hasReadNumber = true
			n := tok.value
			if sc.skipSymbol(':') {
				if sc.skipSymbol(':') {
					if tod.index != 0 {
						return time.Time{}, false
					}
					tod.add(n)
					tod.add(0)
				} else {
					if !tod.add(n) {
						return time.Time{}, false
					}
					if sc.peek().isSymbol('.') {
						sc.advance()
					}
				}
			} else if sc.skipSymbol('.') && tod.isExpecting(n) {
				tod.add(n)
				if sc.peek().kind != tokNumber {
					return time.Time{}, false
				}
				ms := readMilliseconds(sc.advance())
				if ms < 0 {
					return time.Time{}, false
				}
				tod.addFinal(ms)
			} else if tz.isExpecting(n) {
				tz.minute = n
			} else if tod.isExpecting(n) {
				tod.addFinal(n)
				// A finished time must be followed by the end, white space,
				// "Z" or a sign.
				p := sc.peek()
				if p.kind != tokEnd && p.kind != tokSpace && !p.isKeywordZ() && !p.isSign() {
					return time.Time{}, false
				}
			} else {
				if !day.add(n) {
					return time.Time{}, false
				}
				sc.skipSymbol('-')
			}
		case tok.kind >= tokKeyword:
			switch {
			case tok.kind == kwAMPM && tod.index != 0:
				tod.hourOffset = tok.value
			case tok.kind == kwMonth:
				day.namedMonth = tok.value
				sc.skipSymbol('-')
			case tok.kind == kwZone && hasReadNumber:
				tz.set(tok.value)
			default:
				// Garbage words are illegal once a number has been read, and
				// must be separated from the first number.
				if hasReadNumber || sc.peek().kind == tokNumber {
					return time.Time{}, false
				}
			}
		case tok.isSign() && (tz.isUTC() || tod.index != 0):
			tz.setSign(44 - tok.value)
			n, length := 0, 0
			if sc.peek().kind == tokNumber {
				t := sc.advance()
				n, length = t.value, t.length
			}
			hasReadNumber = true
			switch {
			case sc.peek().isSymbol(':'):
				tz.hour, tz.minute = n, none
			case length == 1 || length == 2:
				tz.hour, tz.minute = n, 0
			case length == 3 || length == 4:
				tz.hour, tz.minute = n/100, n%100
			default:
				return time.Time{}, false
			}
		case (tok.isSign() || tok.isSymbol(')')) && hasReadNumber:
			return time.Time{}, false
		}
	}

	year, month, dom, ok := day.write()
	if !ok {
		return time.Time{}, false
	}
	hour, minute, second, ms, ok := tod.write()
	if !ok {
		return time.Time{}, false
	}
	offset, local, ok := tz.write()
	if !ok {
		return time.Time{}, false
	}
	// MakeDay overflows long before int: every year past ±280000 is out of
	// the ±8.64e15 ms range anyway.
	if year < -280000 || year > 280000 {
		return time.Time{}, false
	}
	const maxMs = 8.64e15
	wall := time.Date(year, time.Month(month), dom, hour, minute, second, ms*int(time.Millisecond), time.UTC)
	var t time.Time
	if local {
		if float64(wall.UnixMilli()) > maxMs+864e6 || float64(wall.UnixMilli()) < -maxMs-864e6 {
			return time.Time{}, false
		}
		t = localToUTC(wall)
	} else {
		t = wall.Add(-time.Duration(offset) * time.Second)
	}
	if v := float64(t.UnixMilli()); v > maxMs || v < -maxMs {
		return time.Time{}, false
	}
	return t, true
}

// localToUTC reads wall's fields as local time. A time skipped or repeated
// by a zone change takes the offset in effect before the change, as ICU's
// UCAL_TZ_LOCAL_FORMER does in Bun (02:30 on a spring-forward night in
// Los Angeles is 10:30Z, where time.Date gives 09:30Z).
func localToUTC(wall time.Time) time.Time {
	offsetAt := func(t time.Time) time.Duration {
		_, off := t.In(time.Local).Zone()
		return time.Duration(off) * time.Second
	}
	before := offsetAt(wall.Add(-30 * time.Hour))
	if t := wall.Add(-before); offsetAt(t) == before {
		return t
	}
	after := offsetAt(wall.Add(-before))
	if t := wall.Add(-after); offsetAt(t) == after {
		return t
	}
	return wall.Add(-before)
}

// ISOString is Date#toISOString(): years outside 0..9999 take six digits and
// a sign.
func ISOString(t time.Time) string {
	t = t.UTC()
	rest := t.Format("-01-02T15:04:05.000Z")
	if y := t.Year(); y >= 0 && y <= 9999 {
		return fmt.Sprintf("%04d%s", y, rest)
	} else if y < 0 {
		return fmt.Sprintf("-%06d%s", -y, rest)
	} else {
		return fmt.Sprintf("+%06d%s", y, rest)
	}
}

const none = math.MinInt32

// parseES5 reads the ISO form. It returns the end token when the whole input
// was read, an invalid token when the input cannot be a date, and otherwise
// the first token the legacy parser must continue from.
func parseES5(sc *dateScanner, day *dayComposer, tod *timeComposer, tz *tzComposer) dateToken {
	if sc.peek().isSign() {
		sign := sc.advance()
		if !sc.peek().isFixedNumber(6) {
			return sign
		}
		s := 44 - sign.value
		year := sc.advance().value
		if s < 0 && year == 0 {
			return sign
		}
		day.add(s * year)
	} else if sc.peek().isFixedNumber(4) {
		day.add(sc.advance().value)
	} else {
		return sc.advance()
	}
	if sc.skipSymbol('-') {
		if p := sc.peek(); !p.isFixedNumber(2) || !isMonth(p.value) {
			return sc.advance()
		}
		day.add(sc.advance().value)
		if sc.skipSymbol('-') {
			if p := sc.peek(); !p.isFixedNumber(2) || !isDay(p.value) {
				return sc.advance()
			}
			day.add(sc.advance().value)
		}
	}
	if sc.peek().kind != kwTimeSeparator {
		if sc.peek().kind != tokEnd {
			return sc.advance()
		}
	} else {
		sc.advance()
		if p := sc.peek(); !p.isFixedNumber(2) || p.value < 0 || p.value > 24 {
			return dateToken{kind: tokInvalid}
		}
		hourIs24 := sc.peek().value == 24
		tod.add(sc.advance().value)
		if !sc.skipSymbol(':') {
			return dateToken{kind: tokInvalid}
		}
		if p := sc.peek(); !p.isFixedNumber(2) || !isMinute(p.value) || (hourIs24 && p.value > 0) {
			return dateToken{kind: tokInvalid}
		}
		tod.add(sc.advance().value)
		if sc.skipSymbol(':') {
			if p := sc.peek(); !p.isFixedNumber(2) || !isMinute(p.value) || (hourIs24 && p.value > 0) {
				return dateToken{kind: tokInvalid}
			}
			tod.add(sc.advance().value)
			if sc.skipSymbol('.') {
				if p := sc.peek(); p.kind != tokNumber || (hourIs24 && p.value > 0) {
					return dateToken{kind: tokInvalid}
				}
				tod.add(readMilliseconds(sc.advance()))
			}
		}
		if sc.peek().isKeywordZ() {
			sc.advance()
			tz.set(0)
		} else if sc.peek().isSign() {
			tz.setSign(44 - sc.advance().value)
			if sc.peek().isFixedNumber(4) {
				hm := sc.advance().value
				if !isHour(hm/100) || !isMinute(hm%100) {
					return dateToken{kind: tokInvalid}
				}
				tz.hour, tz.minute = hm/100, hm%100
			} else {
				if p := sc.peek(); !p.isFixedNumber(2) || !isHour(p.value) {
					return dateToken{kind: tokInvalid}
				}
				tz.hour = sc.advance().value
				if !sc.skipSymbol(':') {
					return dateToken{kind: tokInvalid}
				}
				if p := sc.peek(); !p.isFixedNumber(2) || !isMinute(p.value) {
					return dateToken{kind: tokInvalid}
				}
				tz.minute = sc.advance().value
			}
		}
		if sc.peek().kind != tokEnd {
			return dateToken{kind: tokInvalid}
		}
	}
	if tz.hour == none && tod.index == 0 {
		tz.set(0)
	}
	day.iso = true
	return dateToken{kind: tokEnd}
}

// readMilliseconds keeps the first three significant digits of a fraction,
// using the digit count to account for leading zeros.
func readMilliseconds(t dateToken) int {
	n, length := t.value, t.length
	switch {
	case length == 1:
		n *= 100
	case length == 2:
		n *= 10
	case length > 3:
		if length > maxSignificantDigits {
			length = maxSignificantDigits
		}
		factor := 1
		for ; length > 3; length-- {
			factor *= 10
		}
		n /= factor
	}
	return n
}

func between(x, lo, hi int) bool { return x >= lo && x <= hi }
func isMonth(x int) bool         { return between(x, 1, 12) }
func isDay(x int) bool           { return between(x, 1, 31) }
func isHour(x int) bool          { return between(x, 0, 23) }
func isMinute(x int) bool        { return between(x, 0, 59) }

type dayComposer struct {
	comp       [3]int
	index      int
	namedMonth int
	iso        bool
}

func (d *dayComposer) add(n int) bool {
	if d.index == len(d.comp) {
		return false
	}
	d.comp[d.index] = n
	d.index++
	return true
}

func (d *dayComposer) write() (year, month, day int, ok bool) {
	if d.index < 1 {
		return 0, 0, 0, false
	}
	for d.index < len(d.comp) {
		d.comp[d.index] = 1
		d.index++
	}
	switch {
	case d.namedMonth == 0 && (d.iso || !isDay(d.comp[0])):
		year, month, day = d.comp[0], d.comp[1], d.comp[2]
	case d.namedMonth == 0:
		month, day, year = d.comp[0], d.comp[1], d.comp[2]
	case !isDay(d.comp[0]):
		month, year, day = d.namedMonth, d.comp[0], d.comp[1]
	default:
		month, day, year = d.namedMonth, d.comp[0], d.comp[1]
	}
	if !d.iso {
		if between(year, 0, 49) {
			year += 2000
		} else if between(year, 50, 99) {
			year += 1900
		}
	}
	return year, month, day, isMonth(month) && isDay(day)
}

type timeComposer struct {
	comp       [4]int
	index      int
	hourOffset int
}

func (t *timeComposer) isExpecting(n int) bool {
	return (t.index == 1 && isMinute(n)) || (t.index == 2 && isMinute(n)) || (t.index == 3 && between(n, 0, 999))
}

func (t *timeComposer) add(n int) bool {
	if t.index == len(t.comp) {
		return false
	}
	t.comp[t.index] = n
	t.index++
	return true
}

func (t *timeComposer) addFinal(n int) bool {
	if !t.add(n) {
		return false
	}
	for t.index < len(t.comp) {
		t.comp[t.index] = 0
		t.index++
	}
	return true
}

func (t *timeComposer) write() (hour, minute, second, ms int, ok bool) {
	for t.index < len(t.comp) {
		t.comp[t.index] = 0
		t.index++
	}
	hour, minute, second, ms = t.comp[0], t.comp[1], t.comp[2], t.comp[3]
	if t.hourOffset != none {
		if !between(hour, 0, 12) {
			return 0, 0, 0, 0, false
		}
		hour = hour%12 + t.hourOffset
	}
	if !isHour(hour) || !isMinute(minute) || !isMinute(second) || !between(ms, 0, 999) {
		// Hour 24 is only midnight at the end of the day.
		if hour != 24 || minute != 0 || second != 0 || ms != 0 {
			return 0, 0, 0, 0, false
		}
	}
	return hour, minute, second, ms, true
}

type tzComposer struct {
	sign, hour, minute int
}

func (z *tzComposer) set(hours int) {
	z.sign = 1
	if hours < 0 {
		z.sign = -1
	}
	z.hour, z.minute = hours*z.sign, 0
}

func (z *tzComposer) setSign(s int) {
	z.sign = 1
	if s < 0 {
		z.sign = -1
	}
}

func (z *tzComposer) isExpecting(n int) bool {
	return z.hour != none && z.minute == none && isMinute(n)
}

func (z *tzComposer) isUTC() bool { return z.hour == 0 && z.minute == 0 }

// write returns the offset in seconds, or local when no zone was given.
func (z *tzComposer) write() (offset int, local bool, ok bool) {
	if z.sign == none {
		return 0, true, true
	}
	hour, minute := z.hour, z.minute
	if hour == none {
		hour = 0
	}
	if minute == none {
		minute = 0
	}
	total := uint64(uint32(hour)*3600 + uint32(minute)*60)
	if total > 1<<30-1 {
		return 0, false, false
	}
	if z.sign < 0 {
		return -int(total), false, true
	}
	return int(total), false, true
}

// Token kinds. Keywords are kinds >= tokKeyword; an unknown word is
// tokKeyword itself.
const (
	tokInvalid = iota - 6
	tokUnknown
	tokSpace
	tokNumber
	tokSymbol
	tokEnd
	tokKeyword // an unrecognized word
	kwMonth
	kwZone
	kwTimeSeparator
	kwAMPM
)

const maxSignificantDigits = 9

type dateToken struct {
	kind   int
	value  int
	length int
}

func (t dateToken) isSymbol(c rune) bool { return t.kind == tokSymbol && t.value == int(c) }
func (t dateToken) isSign() bool         { return t.isSymbol('+') || t.isSymbol('-') }
func (t dateToken) isFixedNumber(n int) bool {
	return t.kind == tokNumber && t.length == n
}
func (t dateToken) isKeywordZ() bool { return t.kind == kwZone && t.length == 1 && t.value == 0 }

var dateKeywords = []struct {
	prefix string
	kind   int
	value  int
}{
	{"jan", kwMonth, 1}, {"feb", kwMonth, 2}, {"mar", kwMonth, 3}, {"apr", kwMonth, 4},
	{"may", kwMonth, 5}, {"jun", kwMonth, 6}, {"jul", kwMonth, 7}, {"aug", kwMonth, 8},
	{"sep", kwMonth, 9}, {"oct", kwMonth, 10}, {"nov", kwMonth, 11}, {"dec", kwMonth, 12},
	{"am\x00", kwAMPM, 0}, {"pm\x00", kwAMPM, 12},
	{"ut\x00", kwZone, 0}, {"utc", kwZone, 0}, {"z\x00\x00", kwZone, 0}, {"gmt", kwZone, 0},
	{"cdt", kwZone, -5}, {"cst", kwZone, -6}, {"edt", kwZone, -4}, {"est", kwZone, -5},
	{"mdt", kwZone, -6}, {"mst", kwZone, -7}, {"pdt", kwZone, -7}, {"pst", kwZone, -8},
	{"t\x00\x00", kwTimeSeparator, 0},
}

// dateScanner is V8's DateStringTokenizer over its InputReader, with one
// token of lookahead. A NUL character ends the input.
type dateScanner struct {
	in   []rune
	pos  int
	next dateToken
}

func (s *dateScanner) ch() rune {
	if s.pos < len(s.in) {
		return s.in[s.pos]
	}
	return 0
}

func (s *dateScanner) peek() dateToken { return s.next }

func (s *dateScanner) advance() dateToken {
	t := s.next
	s.next = s.scan()
	return t
}

func (s *dateScanner) skipSymbol(c rune) bool {
	if s.next.isSymbol(c) {
		s.advance()
		return true
	}
	return false
}

// dateWhiteSpace is V8's IsWhiteSpace: WhiteSpace without line terminators.
func dateWhiteSpace(r rune) bool {
	return IsSpace(r) && r != '\n' && r != '\r' && r != 0x2028 && r != 0x2029
}

func (s *dateScanner) scan() dateToken {
	start := s.pos
	c := s.ch()
	switch {
	case c == 0:
		return dateToken{kind: tokEnd}
	case c >= '0' && c <= '9':
		for s.ch() == '0' {
			s.pos++
		}
		n, i := 0, 0
		for c := s.ch(); c >= '0' && c <= '9'; c = s.ch() {
			if i < maxSignificantDigits {
				n = n*10 + int(c-'0')
			}
			i++
			s.pos++
		}
		return dateToken{kind: tokNumber, value: n, length: s.pos - start}
	case c == ':' || c == '-' || c == '+' || c == '.' || c == ')':
		s.pos++
		return dateToken{kind: tokSymbol, value: int(c), length: 1}
	case c >= 'A' && !dateWhiteSpace(c):
		var prefix [3]rune
		n := 0
		for c := s.ch(); c >= 'A' && !dateWhiteSpace(c); c = s.ch() {
			if n < 3 {
				prefix[n] = c | 0x20
			}
			n++
			s.pos++
		}
		for _, k := range dateKeywords {
			if string(prefix[:]) == k.prefix && (n <= 3 || k.kind == kwMonth) {
				return dateToken{kind: k.kind, value: k.value, length: n}
			}
		}
		return dateToken{kind: tokKeyword, length: n}
	case IsSpace(c):
		for c := s.ch(); c != 0 && IsSpace(c); c = s.ch() {
			s.pos++
		}
		return dateToken{kind: tokSpace, length: s.pos - start}
	case c == '(':
		for balance := 0; ; {
			switch s.ch() {
			case ')':
				balance--
			case '(':
				balance++
			}
			s.pos++
			if balance <= 0 || s.ch() == 0 {
				return dateToken{kind: tokUnknown, value: -1, length: 1}
			}
		}
	}
	s.pos++
	return dateToken{kind: tokUnknown, value: -1, length: 1}
}
