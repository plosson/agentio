package sql

import (
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

// sessionControl is Bun's /\b(?:BEGIN|…)\b/i. JavaScript's non-unicode /i
// folds only ASCII letters onto these words, so the text is matched after
// lowering ASCII alone (Go's (?i) would also fold U+017F onto "s").
var sessionControl = regexp.MustCompile(`\b(?:begin|commit|rollback|savepoint|release|pragma|attach|detach|vacuum)\b`)

// assertSingleReadOnlyStatement keeps a read-only profile's query inside the
// read-only scope the command opens: one statement, and no transaction or
// session control. The database still decides whether the statement writes.
func assertSingleReadOnlyStatement(query string, fail plugins.FailFunc) error {
	var normalized strings.Builder
	var quote rune
	lineComment, blockComment := false, false
	text := []rune(query)
	for i := 0; i < len(text); i++ {
		char := text[i]
		var next rune = -1
		if i+1 < len(text) {
			next = text[i+1]
		}
		switch {
		case lineComment:
			if char == '\n' {
				lineComment = false
			}
			normalized.WriteByte(' ')
		case blockComment:
			if char == '*' && next == '/' {
				blockComment = false
				i++
			}
			normalized.WriteByte(' ')
		case quote != 0:
			if char == quote {
				if next == quote {
					i++
				} else {
					quote = 0
				}
			} else if char == '\\' {
				i++
			}
			normalized.WriteByte(' ')
		case char == '-' && next == '-':
			lineComment = true
			i++
			normalized.WriteByte(' ')
		case char == '/' && next == '*':
			blockComment = true
			i++
			normalized.WriteByte(' ')
		case char == '\'' || char == '"' || char == '`':
			quote = char
			normalized.WriteByte(' ')
		default:
			normalized.WriteRune(char)
		}
	}

	var statements []string
	for _, part := range strings.Split(normalized.String(), ";") {
		if jsvalue.Trim(part) != "" {
			statements = append(statements, part)
		}
	}
	if len(statements) != 1 {
		return fail("PERMISSION_DENIED", "Read-only SQL profiles accept exactly one statement", "")
	}
	if sessionControl.MatchString(asciiLower(statements[0])) {
		return fail("PERMISSION_DENIED", "Transaction and session controls are not allowed on a read-only SQL profile", "")
	}
	return nil
}

func asciiLower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	return string(b)
}
