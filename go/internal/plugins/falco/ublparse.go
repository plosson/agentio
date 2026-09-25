package falco

import (
	"errors"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// Minimal UBL Invoice / CreditNote parser for Peppol BIS Billing 3.0. The XML
// is first shaped the way Bun's fast-xml-parser shapes it (namespace prefixes
// removed, text trimmed, attributes as "@_name", a repeated or listed element
// as an array), and the fields are then read with the same rules.

type ublParty struct {
	name, vatNumber, companyNumber          *string
	street, street2, city, zip, country     *string
	contactName, contactPhone, contactEmail *string
}

type ublLine struct {
	id, description, quantity, unitPrice, lineExtensionAmount string
	note, unitCode, taxPercent, taxCategory, currency         *string
}

type ublTaxSubtotal struct {
	taxableAmount, taxAmount string
	taxPercent, taxCategory  *string
}

type ublTotals struct {
	lineExtensionAmount, taxExclusiveAmount, taxInclusiveAmount, prepaidAmount, payableAmount *string
}

type ublPayment struct {
	iban, bic, holderName, reference, referenceType, meansCode *string
}

type ublInvoice struct {
	kind                           string // Invoice or CreditNote
	profile, customization         *string
	number                         string
	issueDate, dueDate             *string
	currency                       string
	language, buyerReference, note *string
	seller, buyer                  ublParty
	lines                          []ublLine
	taxSubtotals                   []ublTaxSubtotal
	totals                         ublTotals
	payment                        ublPayment
}

var ublArrayTags = map[string]bool{
	"InvoiceLine": true, "CreditNoteLine": true, "TaxSubtotal": true, "PaymentMeans": true,
	"PartyIdentification": true, "AdditionalDocumentReference": true, "PartyTaxScheme": true,
}

func child(node any, key string) any {
	o, _ := node.(*jsvalue.Object)
	v, _ := o.Get(key)
	return v
}

func textOf(node any) *string {
	switch t := node.(type) {
	case string:
		if t == "" {
			return nil
		}
		return &t
	case *jsvalue.Object:
		if s, ok := t.Str("#text"); ok {
			s = jsvalue.Trim(s)
			if s == "" {
				return nil
			}
			return &s
		}
	}
	return nil
}

func numAttr(node any, attr string) *string {
	if o, ok := node.(*jsvalue.Object); ok {
		if s, ok := o.Str("@_" + attr); ok && s != "" {
			return &s
		}
	}
	return nil
}

func or(values ...*string) *string { return firstOf(values...) }

func readParty(p any) ublParty {
	legal := child(p, "PartyLegalEntity")
	postal := child(p, "PostalAddress")
	country := child(postal, "Country")
	contact := child(p, "Contact")
	schemes, _ := child(p, "PartyTaxScheme").([]any)

	var vat *string
	for _, scheme := range schemes {
		schemeID := textOf(child(child(scheme, "TaxScheme"), "ID"))
		companyID := textOf(child(scheme, "CompanyID"))
		if schemeID != nil && strings.ToUpper(*schemeID) == "VAT" && companyID != nil {
			vat = companyID
			break
		}
		if vat == nil && companyID != nil {
			vat = companyID
		}
	}
	return ublParty{
		name:          or(textOf(child(child(p, "PartyName"), "Name")), textOf(child(legal, "RegistrationName"))),
		vatNumber:     vat,
		companyNumber: textOf(child(legal, "CompanyID")),
		street:        textOf(child(postal, "StreetName")),
		street2:       textOf(child(postal, "AdditionalStreetName")),
		city:          textOf(child(postal, "CityName")),
		zip:           textOf(child(postal, "PostalZone")),
		country:       textOf(child(country, "IdentificationCode")),
		contactName:   textOf(child(contact, "Name")),
		contactPhone:  textOf(child(contact, "Telephone")),
		contactEmail:  textOf(child(contact, "ElectronicMail")),
	}
}

func readLine(line any, isCredit bool) ublLine {
	item := child(line, "Item")
	price := child(line, "Price")
	qty := child(line, "InvoicedQuantity")
	if isCredit {
		qty = child(line, "CreditedQuantity")
	}
	taxCategory := child(item, "ClassifiedTaxCategory")
	return ublLine{
		id:                  deref(textOf(child(line, "ID")), ""),
		description:         deref(or(textOf(child(item, "Name")), textOf(child(item, "Description"))), ""),
		note:                textOf(child(line, "Note")),
		quantity:            deref(textOf(qty), "1"),
		unitCode:            numAttr(qty, "unitCode"),
		unitPrice:           deref(textOf(child(price, "PriceAmount")), "0"),
		lineExtensionAmount: deref(textOf(child(line, "LineExtensionAmount")), "0"),
		taxPercent:          textOf(child(taxCategory, "Percent")),
		taxCategory:         textOf(child(taxCategory, "ID")),
		currency:            or(numAttr(child(line, "LineExtensionAmount"), "currencyID"), numAttr(child(price, "PriceAmount"), "currencyID")),
	}
}

// jsFalsy is `!value` for a parsed XML node.
func jsFalsy(v any) bool {
	return v == nil || v == ""
}

func asList(v any) []any {
	if arr, ok := v.([]any); ok {
		return arr
	}
	return []any{v}
}

func readTaxTotal(raw any) []ublTaxSubtotal {
	if jsFalsy(raw) {
		return nil
	}
	var out []ublTaxSubtotal
	for _, tt := range asList(raw) {
		subs, _ := child(tt, "TaxSubtotal").([]any)
		for _, s := range subs {
			category := child(s, "TaxCategory")
			out = append(out, ublTaxSubtotal{
				taxableAmount: deref(textOf(child(s, "TaxableAmount")), "0"),
				taxAmount:     deref(textOf(child(s, "TaxAmount")), "0"),
				taxPercent:    textOf(child(category, "Percent")),
				taxCategory:   textOf(child(category, "ID")),
			})
		}
	}
	return out
}

var structuredRef = regexp.MustCompile(`^\+{2}\d{3}/\d{4}/\d{5}\+{2}$`)

func readPayment(raw any) ublPayment {
	if jsFalsy(raw) {
		return ublPayment{}
	}
	for _, pm := range asList(raw) {
		acct := child(pm, "PayeeFinancialAccount")
		means := child(pm, "PaymentMeansCode")
		reference := textOf(child(pm, "PaymentID"))
		refType := numAttr(child(pm, "InstructionID"), "schemeID")
		if refType == nil {
			t := "free"
			if reference != nil && structuredRef.MatchString(*reference) {
				t = "structured"
			}
			refType = &t
		}
		return ublPayment{
			iban:          textOf(child(acct, "ID")),
			bic:           textOf(child(child(acct, "FinancialInstitutionBranch"), "ID")),
			holderName:    textOf(child(acct, "Name")),
			reference:     reference,
			referenceType: refType,
			meansCode:     or(textOf(means), numAttr(means, "listID")),
		}
	}
	return ublPayment{}
}

func parseUbl(src string) (*ublInvoice, error) {
	doc, err := parseFastXML(src, func(tag string) bool { return ublArrayTags[tag] })
	if err != nil {
		return nil, err
	}
	root, _ := doc.Get("Invoice")
	if root == nil {
		root, _ = doc.Get("CreditNote")
	}
	if jsFalsy(root) {
		return nil, errors.New("Not a UBL Invoice or CreditNote document")
	}
	_, isCredit := doc.Get("CreditNote")

	linesKey := "InvoiceLine"
	kind := "Invoice"
	if isCredit {
		linesKey = "CreditNoteLine"
		kind = "CreditNote"
	}
	var lines []ublLine
	rawLines, _ := child(root, linesKey).([]any)
	for _, l := range rawLines {
		lines = append(lines, readLine(l, isCredit))
	}
	currency := textOf(child(root, "DocumentCurrencyCode"))
	if currency == nil && len(lines) > 0 {
		currency = lines[0].currency
	}
	totals := child(root, "LegalMonetaryTotal")
	return &ublInvoice{
		kind:           kind,
		profile:        textOf(child(root, "ProfileID")),
		customization:  textOf(child(root, "CustomizationID")),
		number:         deref(textOf(child(root, "ID")), ""),
		issueDate:      textOf(child(root, "IssueDate")),
		dueDate:        textOf(child(root, "DueDate")),
		currency:       deref(currency, "EUR"),
		language:       numAttr(child(root, "Note"), "languageID"),
		buyerReference: or(textOf(child(root, "BuyerReference")), textOf(child(root, "OrderReference"))),
		note:           textOf(child(root, "Note")),
		seller:         readParty(child(child(root, "AccountingSupplierParty"), "Party")),
		buyer:          readParty(child(child(root, "AccountingCustomerParty"), "Party")),
		lines:          lines,
		taxSubtotals:   readTaxTotal(child(root, "TaxTotal")),
		totals: ublTotals{
			lineExtensionAmount: textOf(child(totals, "LineExtensionAmount")),
			taxExclusiveAmount:  textOf(child(totals, "TaxExclusiveAmount")),
			taxInclusiveAmount:  textOf(child(totals, "TaxInclusiveAmount")),
			prepaidAmount:       textOf(child(totals, "PrepaidAmount")),
			payableAmount:       textOf(child(totals, "PayableAmount")),
		},
		payment: readPayment(child(root, "PaymentMeans")),
	}, nil
}
