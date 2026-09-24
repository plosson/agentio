package jsvalue

import (
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

var (
	collatorMu sync.Mutex
	collator   = collate.New(language.Und)
)

// LocaleCompare is a.localeCompare(b): the root collation, so case and
// accents order after the base letter ("a" < "A" < "b") and punctuation sorts
// before digits and letters.
func LocaleCompare(a, b string) int {
	collatorMu.Lock()
	defer collatorMu.Unlock()
	return collator.CompareString(a, b)
}
