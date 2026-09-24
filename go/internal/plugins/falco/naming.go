package falco

import (
	"fmt"
	"math/rand"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

const (
	supplierMax = 40
	numberMax   = 30
)

var (
	collapseDashes = regexp.MustCompile(`-{2,}`)
	numberUnsafe   = regexp.MustCompile(`[/\\:*?"<>|\s\x{0b}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)
	isoDatePrefix  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})`)
)

func slugify(input string, maxLen int) string {
	s := strings.ToLower(stripMarks(input))
	s = nonSlug.ReplaceAllString(s, "-")
	s = edgeDashes.ReplaceAllString(s, "")
	s = collapseDashes.ReplaceAllString(s, "-")
	if len([]rune(s)) <= maxLen {
		return s
	}
	return trailDashes.ReplaceAllString(jsvalue.Slice(s, maxLen), "")
}

func slugifyNumber(input string) string {
	s := numberUnsafe.ReplaceAllString(input, "-")
	s = collapseDashes.ReplaceAllString(s, "-")
	s = edgeDashes.ReplaceAllString(s, "")
	if utf16Len(s) <= numberMax {
		return s
	}
	return trailDashes.ReplaceAllString(jsvalue.Slice(s, numberMax), "")
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r >= 0x10000 {
			n++
		}
	}
	return n
}

func firstTenChars(iso *string) *string {
	if iso == nil || *iso == "" {
		return nil
	}
	m := isoDatePrefix.FindStringSubmatch(*iso)
	if m == nil {
		return nil
	}
	return &m[1]
}

func firstOf(values ...*string) *string {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func deref(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

// buildBasename is YYYY-MM-DD_<supplier-slug>_<number-slug> for a Peppol document.
func buildBasename(doc *jsvalue.Object) string {
	date := deref(firstOf(firstTenChars(doc.Text("documentDate")), firstTenChars(doc.Text("downloadDate"))), "0000-00-00")
	supplier := slugify(jsvalue.Trim(deref(doc.Text("supplierName"), "")), supplierMax)
	if supplier == "" {
		supplier = "unknown"
	}
	number := slugifyNumber(jsvalue.Trim(deref(firstOf(doc.Text("invoiceReference"), doc.Text("documentNumber")), "")))
	if number == "" {
		number = jsvalue.Slice(deref(doc.Text("id"), ""), 8)
	}
	return fmt.Sprintf("%s_%s_%s", date, supplier, number)
}

// buildBillingBasename is YYYY-MM-DD_<customer-slug>_<number> for an outbound
// billing document; credit notes get a CN_ prefix on the number.
func buildBillingBasename(doc *jsvalue.Object) string {
	date := deref(firstOf(firstTenChars(doc.Text("SendDate")), firstTenChars(doc.Text("CreationDate"))), "0000-00-00")
	customer := slugify(jsvalue.Trim(deref(doc.Text("CustomerName"), "")), supplierMax)
	if customer == "" {
		customer = "unknown"
	}
	number := slugifyNumber(deref(doc.Text("DocumentNumber"), ""))
	if number == "" {
		number = jsvalue.Slice(deref(doc.Text("Id"), ""), 8)
	}
	if t, _ := doc.Str("Type"); t == "CreditNote" {
		number = "CN_" + number
	}
	return fmt.Sprintf("%s_%s_%s", date, customer, number)
}

// uniqueBasename appends _2, _3, ... while the proposed name is taken by
// another document, then falls back to a random 6-digit hex suffix.
func uniqueBasename(proposed string, isTaken func(string) bool) string {
	if !isTaken(proposed) {
		return proposed
	}
	for n := 2; n < 100; n++ {
		candidate := fmt.Sprintf("%s_%d", proposed, n)
		if !isTaken(candidate) {
			return candidate
		}
	}
	return fmt.Sprintf("%s_%06x", proposed, rand.Intn(0x1000000))
}
