package falco

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
)

// workPlan is what a sync run has to do for one document, given what is on
// disk. reuseXml keeps the XML and reads it back rather than re-fetching it; a
// fresh download always re-renders the PDF, so a new XML never sits beside a
// stale rendition.
type workPlan struct {
	skip, reuseXML, writePDF bool
}

func planDocumentWork(haveXML, havePDF, extractPDF, force bool) workPlan {
	needPDF := extractPDF && !havePDF
	if haveXML && !needPDF && !force {
		return workPlan{skip: true}
	}
	reuseXML := haveXML && !force
	return workPlan{reuseXML: reuseXML, writePDF: extractPDF && (!reuseXML || needPDF)}
}

// failIfAnyFailed stops a sync that could not fetch everything from reporting
// success: a scheduled run chained with && would treat a directory of holes as
// complete. It is returned with the summary, so the counts are still printed.
func failIfAnyFailed(run *plugins.RunContext, failedCount, total int) error {
	if failedCount == 0 {
		return nil
	}
	return run.Fail("API_ERROR",
		fmt.Sprintf("%d of %d document(s) could not be downloaded", failedCount, total),
		"Everything else was written. Re-run to retry only what is missing.")
}

func requireOutput(run *plugins.RunContext, in plugins.CommandInput) (string, error) {
	output := opt(in, "output")
	if output == "" {
		return "", run.Fail("INVALID_PARAMS", "required option '--output <dir>' not specified", "")
	}
	return output, nil
}

// renameIfPresent moves <from><ext> to <to><ext> when the source exists.
func renameIfPresent(dir, from, to string, extensions ...string) error {
	for _, ext := range extensions {
		source := filepath.Join(dir, from+ext)
		if fileExists(source) {
			if err := os.Rename(source, filepath.Join(dir, to+ext)); err != nil {
				return err
			}
		}
	}
	return nil
}

func runPeppolSync(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	output, err := requireOutput(run, in)
	if err != nil {
		return nil, err
	}
	since := opt(in, "since")
	if err := requireIsoDate(run, since, "--since"); err != nil {
		return nil, err
	}
	c := clientOf(ctx, run)
	if err := os.MkdirAll(output, 0o777); err != nil {
		return nil, err
	}
	all, err := c.listAllPeppolDocuments(func(page, added, total int) {
		run.Log(fmt.Sprintf("  [page %d] +%d (total so far: %d)", page+1, added, total))
	})
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	documents := filterPeppolDocuments(all, since, opt(in, "sender"))
	if len(documents) == 0 {
		return &syncResult{tally: syncTally{Directory: output}, empty: "No matching documents."}, nil
	}

	m := loadManifest(output)
	basenameToID := indexManifest(m)
	embedded, rendered := 0, 0
	res := &syncResult{tally: syncTally{Directory: output, PDFsEmbedded: &embedded, PDFsRendered: &rendered}}
	t := &res.tally
	for _, d := range documents {
		id := deref(d.text("id"), "undefined")
		basename, renamed, err := resolveBasename(id, buildBasename(d), m, basenameToID, func(from, to string) error {
			return renameIfPresent(output, from, to, ".xml", ".pdf")
		})
		if err != nil {
			return nil, err
		}
		if renamed {
			t.Renamed++
		}
		xmlPath := filepath.Join(output, basename+".xml")
		pdfPath := filepath.Join(output, basename+".pdf")
		plan := planDocumentWork(fileExists(xmlPath), fileExists(pdfPath), flag(in, "extract-pdf"), flag(in, "force"))
		if plan.skip {
			t.Skipped++
			continue
		}

		var xml string
		if plan.reuseXML {
			// Already on disk; here only to produce the missing PDF.
			raw, err := os.ReadFile(xmlPath)
			if err != nil {
				run.Log(fmt.Sprintf("  ✗ %s — %s", basename, err.Error()))
				t.Failed++
				continue
			}
			xml = decodeUTF8(raw)
			t.Skipped++
		} else {
			payload, err := c.downloadPeppolDocumentUbl(id)
			if err == nil {
				err = os.WriteFile(xmlPath, payload, 0o666)
			}
			if err != nil {
				run.Log(fmt.Sprintf("  ✗ %s — %s", basename, err.Error()))
				t.Failed++
				continue
			}
			xml = decodeUTF8(payload)
			t.Downloaded++
		}

		if plan.writePDF {
			var pdf []byte
			var err error
			fromEmbedded := false
			if e := extractEmbeddedPdf(xml); e != nil {
				pdf, fromEmbedded = e.bytes, true
			} else {
				pdf, err = renderUblXMLToPdf(xml)
			}
			if err == nil {
				err = os.WriteFile(pdfPath, pdf, 0o666)
			}
			if err != nil {
				run.Log(fmt.Sprintf("  ✗ %s.pdf — %s", basename, err.Error()))
				t.Failed++
				continue
			}
			if fromEmbedded {
				embedded++
			} else {
				rendered++
			}
		}

		mark := "✓"
		if plan.reuseXML {
			mark = "·"
		}
		res.lines = append(res.lines, fmt.Sprintf("  %s %s  (%s)", mark, basename, describePeppolDocument(d)))
	}

	if err := saveManifest(output, m); err != nil {
		return nil, err
	}
	return res, failIfAnyFailed(run, t.Failed, len(documents))
}

func runInvoicesSync(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	output, err := requireOutput(run, in)
	if err != nil {
		return nil, err
	}
	since := opt(in, "since")
	if err := requireIsoDate(run, since, "--since"); err != nil {
		return nil, err
	}
	types := map[string]bool{}
	for _, v := range strings.Split(opt(in, "include"), ",") {
		if v = jsTrim(v); v != "" {
			types[v] = true
		}
	}
	if len(types) == 0 {
		return nil, run.Fail("INVALID_PARAMS", "--include needs at least one document type", "")
	}

	c := clientOf(ctx, run)
	if err := os.MkdirAll(output, 0o777); err != nil {
		return nil, err
	}
	all, err := c.listBillingDocuments(billingTypes{
		invoices: types["Invoice"], creditNotes: types["CreditNote"], estimates: types["Estimate"],
		advancePayments: types["AdvancePayment"], proformas: types["Proforma"],
	})
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	var documents []*object
	for _, d := range all {
		if since != "" && jsSlice(deref(firstOf(d.text("SendDate"), d.text("CreationDate")), ""), 10) < since {
			continue
		}
		if customer := opt(in, "customer"); customer != "" && !containsInsensitive(d.text("CustomerName"), strings.ToLower(customer)) {
			continue
		}
		// The endpoint can be over-inclusive, so keep only what was asked for.
		if t, ok := d.str("Type"); !ok || !types[t] {
			continue
		}
		documents = append(documents, d)
	}
	if len(documents) == 0 {
		return &syncResult{tally: syncTally{Directory: output}, empty: "No billing documents match."}, nil
	}

	m := loadManifest(output)
	basenameToID := indexManifest(m)
	res := &syncResult{tally: syncTally{Directory: output}}
	t := &res.tally
	for _, d := range documents {
		id := deref(d.text("Id"), "undefined")
		basename, renamed, err := resolveBasename(id, buildBillingBasename(d), m, basenameToID, func(from, to string) error {
			return renameIfPresent(output, from, to, ".pdf")
		})
		if err != nil {
			return nil, err
		}
		if renamed {
			t.Renamed++
		}
		pdfPath := filepath.Join(output, basename+".pdf")
		if !flag(in, "force") && fileExists(pdfPath) {
			t.Skipped++
			continue
		}
		payload, err := c.downloadBillingDocumentPdf(id)
		if err == nil {
			err = os.WriteFile(pdfPath, payload, 0o666)
		}
		if err != nil {
			run.Log(fmt.Sprintf("  ✗ %s — %s", basename, err.Error()))
			t.Failed++
			continue
		}
		t.Downloaded++
		res.lines = append(res.lines, fmt.Sprintf("  ✓ %s  (%s)", basename, describeBillingDocument(d)))
	}

	if err := saveManifest(output, m); err != nil {
		return nil, err
	}
	return res, failIfAnyFailed(run, t.Failed, len(documents))
}

func matchesPeppolRef(d *object, ref string) bool {
	return is(d, "id", ref) || is(d, "invoiceReference", ref) || is(d, "documentNumber", ref) ||
		is(d, "fiduciaryDocumentId", ref) || is(d, "paymentReference", ref)
}

func noRef(d *object) string {
	return deref(firstOf(d.text("invoiceReference"), d.text("documentNumber")), "(no ref)")
}

// resolveImportPeppolDocument matches the same refs as mark-paid's Peppol
// fallback but never looks at /document/invoices, the import's destination.
func resolveImportPeppolDocument(ref string, documents []*object) (*object, error) {
	var matches []*object
	for _, d := range documents {
		if matchesPeppolRef(d, ref) {
			matches = append(matches, d)
		}
	}
	if len(matches) > 1 {
		lines := make([]string, len(matches))
		for i, d := range matches {
			lines[i] = fmt.Sprintf("  %s  id=%s  state=%s", noRef(d), deref(d.text("id"), "undefined"), deref(d.text("importState"), "-"))
		}
		return nil, &apiError{
			code:       "INVALID_PARAMS",
			message:    fmt.Sprintf("\"%s\" matches %d Peppol documents:\n%s", ref, len(matches), strings.Join(lines, "\n")),
			suggestion: "Re-run with the Peppol document id",
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	return nil, &apiError{
		code:       "NOT_FOUND",
		message:    fmt.Sprintf("No Peppol document matches \"%s\"", ref),
		suggestion: "Pass a Peppol document id, invoice reference, document number, or fiduciary document id. Run: agentio falco peppol list",
	}
}

func runPeppolImport(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	c := clientOf(ctx, run)
	asJSON := opt(in, "format") == "json"
	documents, err := c.listAllPeppolDocuments(nil)
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	document, err := resolveImportPeppolDocument(arg(in, "ref"), documents)
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	label := describePeppolPaymentTarget(document)
	if v, _ := document.get("doNotImport"); truthy(v) {
		return nil, run.Fail("INVALID_PARAMS", label+" is marked do-not-import", "Clear that flag in Falco before importing, or pick another document")
	}
	if is(document, "importState", "Imported") {
		return nil, run.Fail("INVALID_PARAMS", label+" is already imported", "Nothing to do. Run: agentio falco peppol list")
	}
	id := deref(document.text("id"), "undefined")
	if flag(in, "dry-run") {
		run.Log(fmt.Sprintf("Would import %s (id=%s, state=%s)", label, id, deref(document.text("importState"), dash)))
		return record{value: document, asJSON: asJSON}, nil
	}

	updated, err := c.importPeppolDocumentToFalco(id)
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	confirmed := is(updated, "importState", "Imported")
	mark := " (unverified)"
	if confirmed {
		mark = " ✓"
	}
	run.Log(fmt.Sprintf("%s: %s -> %s%s", label, deref(document.text("importState"), "?"), deref(updated.text("importState"), "?"), mark))

	// Best-effort: show the register row when Falco has finished creating it.
	var invoice *object
	if invoices, err := c.listAllInvoices(); err != nil {
		run.Log("  could not re-read invoice register: " + err.Error())
	} else {
		for _, inv := range invoices {
			if is(inv, "peppolInvoiceId", id) {
				invoice = inv
				break
			}
		}
	}
	if invoice != nil {
		run.Log(fmt.Sprintf("  invoice register: %s  id=%s", describeInvoice(invoice), deref(invoice.text("id"), "undefined")))
	} else if confirmed {
		run.Log("  invoice register: not visible yet (import accepted)")
	}

	out := newObject()
	out.set("document", updated)
	if invoice != nil {
		out.set("invoice", invoice)
	} else {
		out.set("invoice", nil)
	}
	res := record{value: out, asJSON: asJSON}
	if !confirmed {
		return res, run.Fail("API_ERROR",
			"Falco accepted the import but importState is "+deref(updated.text("importState"), "unknown"),
			"Re-run with the same ref to confirm, or check the Falco purchase-invoices view")
	}
	return res, nil
}

// markPaidTarget is either an invoice-register row or a Peppol inbox row.
type markPaidTarget struct {
	invoice, document *object
}

// resolveMarkPaidTarget prefers the local invoice register and falls back to
// the Peppol inbox when the register has no match: organizations that import
// Peppol documents into a fiduciary never see them under /document/invoices.
func resolveMarkPaidTarget(ref string, invoices, peppolDocuments []*object) (markPaidTarget, error) {
	var invoiceMatches []*object
	for _, i := range invoices {
		if is(i, "id", ref) || is(i, "peppolInvoiceId", ref) || is(i, "invoiceReference", ref) {
			invoiceMatches = append(invoiceMatches, i)
		}
	}
	if len(invoiceMatches) > 1 {
		lines := make([]string, len(invoiceMatches))
		for n, i := range invoiceMatches {
			lines[n] = fmt.Sprintf("  %s  id=%s  peppol=%s", deref(i.text("invoiceReference"), "(no ref)"),
				deref(i.text("id"), "undefined"), deref(i.text("peppolInvoiceId"), "-"))
		}
		return markPaidTarget{}, &apiError{
			code:       "INVALID_PARAMS",
			message:    fmt.Sprintf("\"%s\" matches %d invoices:\n%s", ref, len(invoiceMatches), strings.Join(lines, "\n")),
			suggestion: "Re-run with the invoice id",
		}
	}
	if len(invoiceMatches) == 1 {
		return markPaidTarget{invoice: invoiceMatches[0]}, nil
	}

	var peppolMatches []*object
	for _, d := range peppolDocuments {
		if matchesPeppolRef(d, ref) {
			peppolMatches = append(peppolMatches, d)
		}
	}
	if len(peppolMatches) > 1 {
		lines := make([]string, len(peppolMatches))
		for n, d := range peppolMatches {
			lines[n] = fmt.Sprintf("  %s  id=%s  fiduciary=%s", noRef(d), deref(d.text("id"), "undefined"), deref(d.text("fiduciaryDocumentId"), "-"))
		}
		return markPaidTarget{}, &apiError{
			code:       "INVALID_PARAMS",
			message:    fmt.Sprintf("\"%s\" matches %d Peppol documents:\n%s", ref, len(peppolMatches), strings.Join(lines, "\n")),
			suggestion: "Re-run with the Peppol document id",
		}
	}
	if len(peppolMatches) == 1 {
		return markPaidTarget{document: peppolMatches[0]}, nil
	}
	return markPaidTarget{}, &apiError{
		code:       "NOT_FOUND",
		message:    fmt.Sprintf("No invoice or Peppol document matches \"%s\"", ref),
		suggestion: "Pass a Peppol document id, invoice id, invoice reference, or fiduciary document id. Run: agentio falco peppol list",
	}
}

func runMarkPaid(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	// Validate what was typed before --unpaid overrides it, so a bad --status
	// is never silently discarded by the shortcut.
	status := opt(in, "status")
	if status != "Paid" && status != "NotPaid" {
		return nil, run.Fail("INVALID_PARAMS", "--status must be Paid or NotPaid, got: "+status, "")
	}
	if flag(in, "unpaid") {
		status = "NotPaid"
	}
	asJSON := opt(in, "format") == "json"
	ref := arg(in, "ref")
	c := clientOf(ctx, run)

	invoices, err := c.listAllInvoices()
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	hits := 0
	for _, i := range invoices {
		if is(i, "id", ref) || is(i, "peppolInvoiceId", ref) || is(i, "invoiceReference", ref) {
			hits++
		}
	}
	// Only read the Peppol inbox when the register has nothing, which keeps the
	// common path on one list call.
	var peppolDocuments []*object
	if hits == 0 {
		if peppolDocuments, err = c.listAllPeppolDocuments(nil); err != nil {
			return nil, failed(run.Fail, err)
		}
	}
	target, err := resolveMarkPaidTarget(ref, invoices, peppolDocuments)
	if err != nil {
		return nil, failed(run.Fail, err)
	}

	row, label := target.invoice, ""
	write := c.setInvoicePaymentStatus
	reread := c.listAllInvoices
	if row != nil {
		label = describeInvoice(row)
	} else {
		row, label = target.document, describePeppolPaymentTarget(target.document)
		write = c.setPeppolDocumentPaymentStatus
		reread = func() ([]*object, error) { return c.listAllPeppolDocuments(nil) }
	}
	id := deref(row.text("id"), "undefined")

	if is(row, "paymentStatus", status) {
		run.Log(fmt.Sprintf("%s is already %s; nothing to do.", label, status))
		return record{value: row, asJSON: asJSON}, nil
	}
	if err := write(id, status); err != nil {
		return nil, failed(run.Fail, err)
	}

	// The write has landed. Everything below only confirms it, so a failure
	// here must never be reported as though the change did not happen.
	var updated *object
	if rows, err := reread(); err != nil {
		run.Log("  could not re-read to confirm: " + err.Error())
	} else {
		for _, r := range rows {
			if is(r, "id", id) {
				updated = r
				break
			}
		}
	}
	confirmed := updated != nil && is(updated, "paymentStatus", status)
	to := status
	if updated != nil {
		to = deref(updated.text("paymentStatus"), status)
	}
	run.Log(paymentStatusChange(label, row.text("paymentStatus"), to, confirmed))

	var res any
	if updated != nil {
		res = record{value: updated, asJSON: asJSON}
	}
	if !confirmed {
		return res, run.Fail("API_ERROR",
			fmt.Sprintf("Falco accepted the change to %s but it is not visible yet", status),
			"The write was sent; nothing needs redoing. Re-run to confirm it landed.")
	}
	return res, nil
}
