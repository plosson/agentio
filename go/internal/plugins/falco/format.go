package falco

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

const dash = "—"

func fmtDate(iso *string) string {
	if iso == nil || *iso == "" {
		return dash
	}
	return jsvalue.Slice(*iso, 10)
}

// fmtAmount is the amount and its currency ("€" for EUR), trimmed, or a dash
// when the amount is falsy.
func fmtAmount(o *jsvalue.Object, amountKey, currencyKey string) string {
	amount, _ := o.Get(amountKey)
	if !jsvalue.Truthy(amount) {
		return dash
	}
	symbol := ""
	if c := o.Text(currencyKey); c != nil {
		symbol = *c
		if cur, _ := o.Str(currencyKey); cur == "EUR" {
			symbol = "€"
		}
	}
	return jsvalue.Trim(jsvalue.String(amount) + " " + symbol)
}

// pad left-aligns, truncating with an ellipsis so columns never drift.
func pad(value string, width int) string {
	n := utf16Len(value)
	if n >= width {
		return jsvalue.Slice(value, width-1) + "…"
	}
	return value + strings.Repeat(" ", width-n)
}

// padLeft right-aligns with the same truncation rule.
func padLeft(value string, width int) string {
	n := utf16Len(value)
	if n >= width {
		return jsvalue.Slice(value, width-1) + "…"
	}
	return strings.Repeat(" ", width-n) + value
}

func formatPeppolDocuments(documents []*jsvalue.Object) string {
	if len(documents) == 0 {
		return "No Peppol documents match."
	}
	header := pad("DATE", 11) + pad("NUMBER", 18) + pad("SUPPLIER", 40) + padLeft("AMOUNT", 14) + "  " + pad("STATE", 14) + "ID"
	lines := []string{header, strings.Repeat("-", utf16Len(header))}
	for _, d := range documents {
		supplier := deref(d.Text("supplierName"), "?")
		if vat, _ := d.Get("supplierVatNumber"); jsvalue.Truthy(vat) {
			supplier += " (" + jsvalue.String(vat) + ")"
		}
		lines = append(lines,
			pad(fmtDate(d.Text("documentDate")), 11)+
				pad(deref(d.Text("documentNumber"), dash), 18)+
				pad(supplier, 40)+
				padLeft(fmtAmount(d, "amount", "currency"), 14)+
				"  "+
				pad(deref(d.Text("importState"), dash), 14)+
				deref(d.Text("id"), "undefined"))
	}
	lines = append(lines, "", fmt.Sprintf("%d document(s)", len(documents)))
	return strings.Join(lines, "\n")
}

func describeInvoice(inv *jsvalue.Object) string {
	ref := deref(inv.Text("invoiceReference"), deref(inv.Text("id"), "undefined"))
	return fmt.Sprintf("%s (%s, %s)", ref, deref(inv.Text("supplierName"), "?"), fmtAmount(inv, "amount", "invoiceCurrency"))
}

// describePeppolPaymentTarget has describeInvoice's shape, for inbox rows that
// never reach /document/invoices.
func describePeppolPaymentTarget(d *jsvalue.Object) string {
	ref := deref(firstOf(d.Text("invoiceReference"), d.Text("documentNumber"), d.Text("id")), "undefined")
	return fmt.Sprintf("%s (%s, %s)", ref, deref(d.Text("supplierName"), "?"), fmtAmount(d, "amount", "currency"))
}

func describePeppolDocument(d *jsvalue.Object) string {
	return fmt.Sprintf("%s  %s  %s", fmtDate(d.Text("documentDate")), deref(d.Text("supplierName"), "?"), fmtAmount(d, "amount", "currency"))
}

func describeBillingDocument(d *jsvalue.Object) string {
	date := fmtDate(firstOf(d.Text("SendDate"), d.Text("CreationDate")))
	return jsvalue.Trim(fmt.Sprintf("%s  %s  %s %s", date, deref(d.Text("CustomerName"), "?"),
		deref(d.Text("FinalAmount"), "?"), deref(d.Text("CurrencyCode"), "")))
}

func paymentStatusChange(label string, from *string, to string, confirmed bool) string {
	mark := " (unverified)"
	if confirmed {
		mark = " ✓"
	}
	return fmt.Sprintf("%s: %s -> %s%s", label, deref(from, "?"), to, mark)
}

func fileWritten(path string, n int, note string) string {
	if note != "" {
		return fmt.Sprintf("wrote %s (%d bytes, %s)", path, n, note)
	}
	return fmt.Sprintf("wrote %s (%d bytes)", path, n)
}

// --- command results ------------------------------------------------------------

// peppolList prints as the Bun table, or as the documents with --format json.
// The host's --json is always the documents.
type peppolList struct {
	documents []*jsvalue.Object
	asJSON    bool
}

func (l peppolList) value() []any {
	out := make([]any, len(l.documents))
	for i, d := range l.documents {
		out[i] = d
	}
	return out
}

func (l peppolList) MarshalJSON() ([]byte, error) {
	return jsvalue.Stringify(l.value()), nil
}

func formatPeppolList(v any) string {
	l, ok := v.(peppolList)
	if !ok {
		return ""
	}
	if l.asJSON {
		return string(jsvalue.StringifyIndent(l.value()))
	}
	return formatPeppolDocuments(l.documents)
}

// record is a command whose stdout is one JSON value, printed only when
// --format json asked for it (mark-paid, import).
type record struct {
	value  any
	asJSON bool
}

func (r record) MarshalJSON() ([]byte, error) {
	return jsvalue.Stringify(r.value), nil
}

func formatRecord(v any) string {
	r, ok := v.(record)
	if !ok || !r.asJSON {
		return ""
	}
	return string(jsvalue.StringifyIndent(r.value))
}

// written is peppol get: the XML on stdout for --output -, otherwise the
// paths written (reported on stderr as Bun does).
type written struct {
	XML      *string `json:"xml,omitempty"`
	XMLPath  string  `json:"xmlPath,omitempty"`
	Bytes    int     `json:"bytes"`
	PDFPath  string  `json:"pdfPath,omitempty"`
	PDFBytes *int    `json:"pdfBytes,omitempty"`
	PDFNote  string  `json:"pdfNote,omitempty"`
}

func formatWritten(v any) string {
	w, ok := v.(*written)
	if !ok || w.XML == nil {
		return ""
	}
	// Bun writes the XML with exactly one trailing newline added when missing;
	// the host adds that newline.
	return strings.TrimSuffix(*w.XML, "\n")
}

// syncTally is SyncTally; the PDF counts exist only for Peppol syncs.
type syncTally struct {
	Directory    string `json:"directory"`
	Downloaded   int    `json:"downloaded"`
	Skipped      int    `json:"skipped"`
	Renamed      int    `json:"renamed"`
	Failed       int    `json:"failed"`
	PDFsEmbedded *int   `json:"pdfsExtracted,omitempty"`
	PDFsRendered *int   `json:"pdfsRendered,omitempty"`
}

type syncResult struct {
	tally syncTally
	lines []string
	// empty is the message printed instead of a summary when nothing matched.
	empty string
}

func (r *syncResult) MarshalJSON() ([]byte, error) { return json.Marshal(r.tally) }

func formatSync(v any) string {
	r, ok := v.(*syncResult)
	if !ok {
		return ""
	}
	if r.empty != "" {
		return r.empty
	}
	t := r.tally
	parts := []string{
		fmt.Sprintf("%d downloaded", t.Downloaded),
		fmt.Sprintf("%d already on disk", t.Skipped),
		fmt.Sprintf("%d renamed", t.Renamed),
		fmt.Sprintf("%d failed", t.Failed),
	}
	if t.PDFsEmbedded != nil || t.PDFsRendered != nil {
		parts = append(parts, fmt.Sprintf("%d PDFs extracted", deInt(t.PDFsEmbedded)), fmt.Sprintf("%d PDFs rendered", deInt(t.PDFsRendered)))
	}
	lines := append(append([]string{}, r.lines...), "", fmt.Sprintf("Done: %s. Dir: %s", strings.Join(parts, ", "), t.Directory))
	return strings.Join(lines, "\n")
}

func deInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
