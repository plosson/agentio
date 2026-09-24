package falco

import (
	"bytes"
	"fmt"
	"math"
	"regexp"
	"strings"

	"github.com/go-pdf/fpdf"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// A rendition of a UBL invoice for documents that embed no PDF. It follows
// Bun's pdf-lib layout (A4, Helvetica, same positions and colours). pdf-lib
// works bottom-up; fpdf works top-down, so every y is flipped at the call.

const (
	a4Width      = 595.28
	a4Height     = 841.89
	marginX      = 40.0
	marginTop    = 48.0
	marginBottom = 48.0
	// pdf-lib's default line height for the lines of one drawText call.
	pageLineHeight = 24.0
)

type colour struct{ r, g, b float64 }

var (
	ink    = colour{0.12, 0.12, 0.12}
	muted  = colour{0.45, 0.45, 0.45}
	accent = colour{0.1, 0.35, 0.6}
	rule   = colour{0.85, 0.85, 0.85}
	band   = colour{0.95, 0.96, 0.98}
)

func (c colour) ints() (int, int, int) {
	to := func(v float64) int { return int(math.Round(v * 255)) }
	return to(c.r), to(c.g), to(c.b)
}

// winAnsiExtra is the WinAnsi (cp1252) mapping for code points outside Latin-1.
var winAnsiExtra = map[rune]byte{
	0x152: 0x8c, 0x153: 0x9c, 0x160: 0x8a, 0x161: 0x9a, 0x178: 0x9f, 0x17d: 0x8e, 0x17e: 0x9e,
	0x192: 0x83, 0x2c6: 0x88, 0x2dc: 0x98, 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92,
	0x201a: 0x82, 0x201c: 0x93, 0x201d: 0x94, 0x201e: 0x84, 0x2020: 0x86, 0x2021: 0x87, 0x2022: 0x95,
	0x2026: 0x85, 0x2030: 0x89, 0x2039: 0x8b, 0x203a: 0x9b, 0x20ac: 0x80, 0x2122: 0x99,
}

// winAnsi encodes text for a standard font. Like pdf-lib, a character the
// encoding lacks fails the whole rendition with the same message.
func winAnsi(s string) (string, error) {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 0x20 && r <= 0x7e, r >= 0xa0 && r <= 0xff:
			b.WriteByte(byte(r))
		default:
			c, ok := winAnsiExtra[r]
			if !ok {
				return "", fmt.Errorf("WinAnsi cannot encode \"%s\" (0x%04x)", string(rune(r&0xffff)), r)
			}
			b.WriteByte(c)
		}
	}
	return b.String(), nil
}

type renderer struct {
	pdf     *fpdf.Fpdf
	cursorY float64
	err     error
}

func (r *renderer) setFont(size float64, bold bool) {
	style := ""
	if bold {
		style = "B"
	}
	r.pdf.SetFont("Helvetica", style, size)
}

// width is widthOfTextAtSize.
func (r *renderer) width(text string, size float64, bold bool) float64 {
	enc, err := winAnsi(text)
	if err != nil {
		r.fail(err)
		return 0
	}
	r.setFont(size, bold)
	return r.pdf.GetStringWidth(enc)
}

func (r *renderer) fail(err error) {
	if r.err == nil {
		r.err = err
	}
}

func (r *renderer) ensureSpace(needed float64) {
	if r.cursorY-needed < marginBottom {
		r.pdf.AddPageFormat("P", fpdf.SizeType{Wd: a4Width, Ht: a4Height})
		r.cursorY = a4Height - marginTop
	}
}

var controlChars = regexp.MustCompile("[\x00-\x08\x0b-\x1f]")

type textOpts struct {
	size     float64
	bold     bool
	color    *colour
	maxWidth float64
}

func (r *renderer) drawText(text string, x, y float64, o textOpts) {
	if r.err != nil {
		return
	}
	size := o.size
	if size == 0 {
		size = 10
	}
	color := ink
	if o.color != nil {
		color = *o.color
	}
	out := []rune(controlChars.ReplaceAllString(text, ""))
	if o.maxWidth > 0 {
		for len(out) > 0 && r.width(string(out), size, o.bold) > o.maxWidth && r.err == nil {
			cut := len(out) - 2
			if cut < 0 {
				cut = 0
			}
			out = append(out[:cut:cut], '…')
		}
	}
	// pdf-lib turns a tab into four spaces and draws each line of the text
	// one default line height apart.
	cleaned := strings.NewReplacer("\t", "    ", "\u0085", "    ", "\u2028", "    ", "\u2029", "    ").Replace(string(out))
	r.setFont(size, o.bold)
	cr, cg, cb := color.ints()
	r.pdf.SetTextColor(cr, cg, cb)
	for i, line := range strings.Split(cleaned, "\n") {
		enc, err := winAnsi(line)
		if err != nil {
			r.fail(err)
			return
		}
		r.pdf.Text(x, a4Height-(y-float64(i)*pageLineHeight), enc)
	}
}

var jsWhitespaceRun = regexp.MustCompile(`[\s\x{0b}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+`)

// wrap breaks text into lines of at most maxWidth, hard-breaking a word that
// is too long on its own.
func (r *renderer) wrap(size float64, text string, maxWidth float64) []string {
	var lines []string
	line := ""
	for _, w := range jsWhitespaceRun.Split(text, -1) {
		candidate := w
		if line != "" {
			candidate = line + " " + w
		}
		if r.width(candidate, size, false) <= maxWidth {
			line = candidate
			continue
		}
		if line != "" {
			lines = append(lines, line)
		}
		if r.width(w, size, false) > maxWidth {
			chunk := []rune(w)
			for r.width(string(chunk), size, false) > maxWidth && len(chunk) > 1 && r.err == nil {
				chunk = chunk[:len(chunk)-1]
			}
			lines = append(lines, string(chunk))
			line = string([]rune(w)[len(chunk):])
		} else {
			line = w
		}
	}
	if line != "" {
		lines = append(lines, line)
	}
	return lines
}

func (r *renderer) rule(y float64) {
	cr, cg, cb := rule.ints()
	r.pdf.SetDrawColor(cr, cg, cb)
	r.pdf.SetLineWidth(0.5)
	r.pdf.Line(marginX, a4Height-y, a4Width-marginX, a4Height-y)
}

var isoDateParts = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)

func formatDate(iso *string) string {
	if iso == nil || *iso == "" {
		return "—"
	}
	if m := isoDateParts.FindStringSubmatch(*iso); m != nil {
		return m[3] + "/" + m[2] + "/" + m[1]
	}
	return *iso
}

func formatMoney(amount *string, currency string) string {
	if amount == nil || *amount == "" {
		return "—"
	}
	n := jsvalue.Number(*amount)
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return *amount + " " + currency
	}
	return jsvalue.ToFixed(n, 2) + " " + currency
}

func addressLines(p ublParty) []string {
	var lines []string
	if p.street != nil {
		lines = append(lines, *p.street)
	}
	if p.street2 != nil {
		lines = append(lines, *p.street2)
	}
	var zipCity []string
	for _, s := range []*string{p.zip, p.city} {
		if s != nil {
			zipCity = append(zipCity, *s)
		}
	}
	if line := strings.Join(zipCity, " "); line != "" {
		lines = append(lines, line)
	}
	if p.country != nil {
		lines = append(lines, *p.country)
	}
	return lines
}

func (r *renderer) drawParty(p ublParty, x, width, startY float64) float64 {
	const lineHeight = 12.0
	y := startY
	if p.name != nil {
		r.drawText(*p.name, x, y, textOpts{size: 10, bold: true, maxWidth: width})
		y -= lineHeight
	}
	for _, l := range addressLines(p) {
		r.drawText(l, x, y, textOpts{size: 9, color: &ink, maxWidth: width})
		y -= lineHeight - 1
	}
	small := func(s string) {
		r.drawText(s, x, y, textOpts{size: 9, color: &muted, maxWidth: width})
		y -= lineHeight - 1
	}
	if p.vatNumber != nil {
		small("VAT: " + *p.vatNumber)
	}
	if p.companyNumber != nil && (p.vatNumber == nil || *p.companyNumber != *p.vatNumber) {
		small("Reg. #: " + *p.companyNumber)
	}
	if p.contactEmail != nil {
		small(*p.contactEmail)
	}
	if p.contactPhone != nil {
		small(*p.contactPhone)
	}
	return y
}

type column struct {
	header string
	width  float64
	right  bool
}

func (r *renderer) drawLinesTable(inv *ublInvoice) {
	cols := []column{
		{"#", 22, false},
		{"Description", 270, false},
		{"Qty", 48, true},
		{"Unit price", 70, true},
		{"VAT", 38, true},
		{"Line total", 76, true},
	}
	tableWidth := 0.0
	for _, c := range cols {
		tableWidth += c.width
	}

	r.ensureSpace(24)
	y := r.cursorY
	x := marginX
	br, bg, bb := band.ints()
	r.pdf.SetFillColor(br, bg, bb)
	r.pdf.Rect(marginX, a4Height-(y-14+18), tableWidth, 18, "F")
	for _, col := range cols {
		textX := x + 6
		if col.right {
			textX = x + col.width - 6 - r.width(col.header, 9, true)
		}
		r.drawText(col.header, textX, y-10, textOpts{size: 9, bold: true, color: &accent})
		x += col.width
	}
	y -= 20
	r.rule(y + 4)
	r.cursorY = y

	const rowBaseHeight = 12.0
	for i, line := range inv.lines {
		description := line.description
		if description == "" && line.note != nil {
			description = *line.note
		}
		wrapped := r.wrap(9, description, cols[1].width-12)
		rowHeight := math.Max(rowBaseHeight, float64(len(wrapped))*11+4)
		r.ensureSpace(rowHeight + 4)
		y = r.cursorY
		x = marginX

		qty := line.quantity
		quantity := jsvalue.NumberString(jsvalue.Number(qty))
		if line.unitCode != nil {
			quantity += " " + *line.unitCode
		}
		vat := "—"
		if line.taxPercent != nil {
			vat = jsvalue.NumberString(jsvalue.Number(*line.taxPercent)) + "%"
		}
		first := ""
		if len(wrapped) > 0 {
			first = wrapped[0]
		}
		unitPrice, lineTotal := line.unitPrice, line.lineExtensionAmount
		values := []struct {
			text  string
			right bool
			lines []string
		}{
			{fmt.Sprint(i + 1), false, nil},
			{first, false, wrapped},
			{quantity, true, nil},
			{formatMoney(&unitPrice, inv.currency), true, nil},
			{vat, true, nil},
			{formatMoney(&lineTotal, inv.currency), true, nil},
		}
		for j, col := range cols {
			v := values[j]
			if len(v.lines) > 1 {
				for k, l := range v.lines {
					r.drawText(l, x+6, y-10-float64(k)*11, textOpts{size: 9})
				}
			} else {
				textX := x + 6
				if v.right {
					textX = x + col.width - 6 - r.width(v.text, 9, false)
				}
				r.drawText(v.text, textX, y-10, textOpts{size: 9})
			}
			x += col.width
		}
		y -= rowHeight
		r.rule(y + 2)
		r.cursorY = y
	}
}

func (r *renderer) drawTotalsBlock(inv *ublInvoice) {
	r.ensureSpace(120)
	r.cursorY -= 10
	rightEdge := a4Width - marginX
	blockX := rightEdge - 240
	y := r.cursorY

	type row struct {
		label, value string
		bold         bool
		color        *colour
	}
	rows := []row{{label: "Subtotal (excl. tax)", value: formatMoney(or(inv.totals.taxExclusiveAmount, inv.totals.lineExtensionAmount), inv.currency)}}
	for _, t := range inv.taxSubtotals {
		label := "VAT"
		if t.taxPercent != nil {
			label += " " + jsvalue.NumberString(jsvalue.Number(*t.taxPercent)) + "%"
		}
		if t.taxCategory != nil {
			label += " [" + *t.taxCategory + "]"
		}
		amount := t.taxAmount
		rows = append(rows, row{label: label, value: formatMoney(&amount, inv.currency)})
	}
	if p := inv.totals.prepaidAmount; p != nil && *p != "0.00" && *p != "0" {
		rows = append(rows, row{label: "Prepaid", value: "-" + formatMoney(p, inv.currency)})
	}
	rows = append(rows,
		row{label: "Total (incl. tax)", value: formatMoney(or(inv.totals.taxInclusiveAmount, inv.totals.payableAmount), inv.currency)},
		row{label: "Amount due", value: formatMoney(inv.totals.payableAmount, inv.currency), bold: true, color: &accent},
	)
	for _, rw := range rows {
		size := 10.0
		if rw.bold {
			size = 11
		}
		c := rw.color
		if c == nil {
			c = &ink
		}
		r.drawText(rw.label, blockX, y, textOpts{size: size, bold: rw.bold, color: c})
		r.drawText(rw.value, rightEdge-r.width(rw.value, size, rw.bold), y, textOpts{size: size, bold: rw.bold, color: c})
		y -= 14
	}
	r.cursorY = y - 4
}

func (r *renderer) drawPaymentBlock(inv *ublInvoice) {
	p := inv.payment
	if p.iban == nil && p.reference == nil {
		return
	}
	r.ensureSpace(60)
	r.cursorY -= 6
	r.rule(r.cursorY)
	r.cursorY -= 12
	r.drawText("Payment", marginX, r.cursorY, textOpts{size: 10, bold: true, color: &accent})
	r.cursorY -= 12
	if p.iban != nil {
		line := "IBAN: " + *p.iban
		if p.bic != nil {
			line += "   BIC: " + *p.bic
		}
		r.drawText(line, marginX, r.cursorY, textOpts{size: 9})
		r.cursorY -= 12
	}
	if p.holderName != nil {
		r.drawText("Beneficiary: "+*p.holderName, marginX, r.cursorY, textOpts{size: 9})
		r.cursorY -= 12
	}
	if p.reference != nil {
		r.drawText(fmt.Sprintf("Reference (%s): %s", deref(p.referenceType, "free"), *p.reference), marginX, r.cursorY, textOpts{size: 9})
		r.cursorY -= 12
	}
	if p.meansCode != nil {
		r.drawText("Means (UNCL 4461 code): "+*p.meansCode, marginX, r.cursorY, textOpts{size: 9, color: &muted})
		r.cursorY -= 12
	}
}

func (r *renderer) drawFooter() {
	text := "Rendered by agentio from the UBL Peppol document. " +
		"This is a machine-generated visual rendition — the UBL XML is the legal document."
	r.drawText(text, marginX, marginBottom-18, textOpts{size: 7.5, color: &muted})
}

// renderUblToPdf draws the invoice on A4 pages and returns the PDF bytes.
func renderUblToPdf(inv *ublInvoice) ([]byte, error) {
	pdf := fpdf.NewCustom(&fpdf.InitType{UnitStr: "pt", Size: fpdf.SizeType{Wd: a4Width, Ht: a4Height}})
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetMargins(0, 0, 0)
	pdf.SetTitle(inv.kind+" "+inv.number, true)
	pdf.SetProducer("agentio", true)
	pdf.SetCreator("agentio", true)
	if inv.seller.name != nil {
		pdf.SetAuthor(*inv.seller.name, true)
	}
	pdf.AddPageFormat("P", fpdf.SizeType{Wd: a4Width, Ht: a4Height})
	r := &renderer{pdf: pdf, cursorY: a4Height - marginTop}

	// Header.
	titleY := r.cursorY
	title := "INVOICE"
	if inv.kind == "CreditNote" {
		title = "CREDIT NOTE"
	}
	r.drawText(title, marginX, titleY, textOpts{size: 22, bold: true, color: &accent})
	metaX := a4Width - marginX - 200
	metaY := titleY + 2
	meta := [][2]string{
		{"Number", inv.number},
		{"Issue date", formatDate(inv.issueDate)},
		{"Due date", formatDate(inv.dueDate)},
		{"Currency", inv.currency},
	}
	if inv.buyerReference != nil {
		meta = append(meta, [2]string{"Buyer ref.", *inv.buyerReference})
	}
	for _, m := range meta {
		r.drawText(m[0]+":", metaX, metaY, textOpts{size: 9, color: &muted})
		r.drawText(m[1], metaX+72, metaY, textOpts{size: 9, bold: true})
		metaY -= 12
	}
	r.cursorY = math.Min(titleY-24, metaY) - 10

	// Seller and buyer columns.
	colWidth := (a4Width - marginX*2 - 20) / 2
	startY := r.cursorY
	r.drawText("From", marginX, startY, textOpts{size: 8, bold: true, color: &muted})
	r.drawText("Bill to", marginX+colWidth+20, startY, textOpts{size: 8, bold: true, color: &muted})
	r.cursorY = startY - 12
	leftEnd := r.drawParty(inv.seller, marginX, colWidth, r.cursorY)
	rightEnd := r.drawParty(inv.buyer, marginX+colWidth+20, colWidth, r.cursorY)
	r.cursorY = math.Min(leftEnd, rightEnd) - 12

	if inv.note != nil && jsvalue.Trim(*inv.note) != "" {
		noteLines := r.wrap(9, jsvalue.Trim(*inv.note), a4Width-marginX*2)
		if len(noteLines) > 4 {
			noteLines = noteLines[:4]
		}
		for _, l := range noteLines {
			r.drawText(l, marginX, r.cursorY, textOpts{size: 9, color: &muted})
			r.cursorY -= 11
		}
		r.cursorY -= 4
	}

	r.drawLinesTable(inv)
	r.drawTotalsBlock(inv)
	r.drawPaymentBlock(inv)
	r.drawFooter()

	if r.err != nil {
		return nil, r.err
	}
	var out bytes.Buffer
	if err := pdf.Output(&out); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// renderUblXMLToPdf parses UBL XML and renders it.
func renderUblXMLToPdf(xml string) ([]byte, error) {
	inv, err := parseUbl(xml)
	if err != nil {
		return nil, err
	}
	return renderUblToPdf(inv)
}
