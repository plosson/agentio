package falco

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
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

// syncInput is what a sync checks before the client. output is Commander's
// requiredOption: a given "" is kept, and then fails in mkdir as in Bun.
type syncInput struct {
	output string
	since  string
	types  map[string]bool // invoices sync --include
}

func peppolSyncInput(in plugins.CommandInput, fail plugins.FailFunc) (syncInput, error) {
	if err := plugins.RequireOptions(in, fail, "--output <dir>"); err != nil {
		return syncInput{}, err
	}
	since, err := requireIsoDate(in, fail, "since")
	return syncInput{output: in.Option("output"), since: since}, err
}

func invoicesSyncInput(in plugins.CommandInput, fail plugins.FailFunc) (syncInput, error) {
	input, err := peppolSyncInput(in, fail)
	if err != nil {
		return input, err
	}
	input.types = map[string]bool{}
	for _, v := range strings.Split(in.Option("include"), ",") {
		if v = jsvalue.Trim(v); v != "" {
			input.types[v] = true
		}
	}
	if len(input.types) == 0 {
		return input, fail("INVALID_PARAMS", "--include needs at least one document type", "")
	}
	return input, nil
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
	input := plugins.Prepared[syncInput](run)
	output, since := input.output, input.since
	c := clientOf(ctx, run)
	if err := nodefs.MkdirAll(output); err != nil {
		return nil, err
	}
	all, err := c.listAllPeppolDocuments(func(page, added, total int) {
		run.Log(fmt.Sprintf("  [page %d] +%d (total so far: %d)", page+1, added, total))
	})
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	documents := filterPeppolDocuments(all, since, in.Option("sender"))
	if len(documents) == 0 {
		return &syncResult{tally: syncTally{Directory: output}, empty: "No matching documents."}, nil
	}

	m := loadManifest(output)
	basenameToID := indexManifest(m)
	embedded, rendered := 0, 0
	res := &syncResult{tally: syncTally{Directory: output, PDFsEmbedded: &embedded, PDFsRendered: &rendered}}
	t := &res.tally
	for _, d := range documents {
		id := deref(d.Text("id"), "undefined")
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
		plan := planDocumentWork(fileExists(xmlPath), fileExists(pdfPath), in.Flag("extract-pdf"), in.Flag("force"))
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
			xml = jsvalue.DecodeUTF8(raw)
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
			xml = jsvalue.DecodeUTF8(payload)
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
	input := plugins.Prepared[syncInput](run)
	output, since, types := input.output, input.since, input.types

	c := clientOf(ctx, run)
	if err := nodefs.MkdirAll(output); err != nil {
		return nil, err
	}
	all, err := c.listBillingDocuments(billingTypes{
		invoices: types["Invoice"], creditNotes: types["CreditNote"], estimates: types["Estimate"],
		advancePayments: types["AdvancePayment"], proformas: types["Proforma"],
	})
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	var documents []*jsvalue.Object
	for _, d := range all {
		if since != "" && jsvalue.Slice(deref(firstOf(d.Text("SendDate"), d.Text("CreationDate")), ""), 10) < since {
			continue
		}
		if customer := in.Option("customer"); customer != "" && !containsInsensitive(d.Text("CustomerName"), strings.ToLower(customer)) {
			continue
		}
		// The endpoint can be over-inclusive, so keep only what was asked for.
		if t, ok := d.Str("Type"); !ok || !types[t] {
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
		id := deref(d.Text("Id"), "undefined")
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
		if !in.Flag("force") && fileExists(pdfPath) {
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

func matchesPeppolRef(d *jsvalue.Object, ref string) bool {
	return is(d, "id", ref) || is(d, "invoiceReference", ref) || is(d, "documentNumber", ref) ||
		is(d, "fiduciaryDocumentId", ref) || is(d, "paymentReference", ref)
}

func noRef(d *jsvalue.Object) string {
	return deref(firstOf(d.Text("invoiceReference"), d.Text("documentNumber")), "(no ref)")
}

// resolveImportPeppolDocument matches the same refs as mark-paid's Peppol
// fallback but never looks at /document/invoices, the import's destination.
func resolveImportPeppolDocument(ref string, documents []*jsvalue.Object) (*jsvalue.Object, error) {
	var matches []*jsvalue.Object
	for _, d := range documents {
		if matchesPeppolRef(d, ref) {
			matches = append(matches, d)
		}
	}
	if len(matches) > 1 {
		lines := make([]string, len(matches))
		for i, d := range matches {
			lines[i] = fmt.Sprintf("  %s  id=%s  state=%s", noRef(d), deref(d.Text("id"), "undefined"), deref(d.Text("importState"), "-"))
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
	asJSON := in.Option("format") == "json"
	documents, err := c.listAllPeppolDocuments(nil)
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	document, err := resolveImportPeppolDocument(in.Arg("ref"), documents)
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	label := describePeppolPaymentTarget(document)
	if v, _ := document.Get("doNotImport"); jsvalue.Truthy(v) {
		return nil, run.Fail("INVALID_PARAMS", label+" is marked do-not-import", "Clear that flag in Falco before importing, or pick another document")
	}
	if is(document, "importState", "Imported") {
		return nil, run.Fail("INVALID_PARAMS", label+" is already imported", "Nothing to do. Run: agentio falco peppol list")
	}
	id := deref(document.Text("id"), "undefined")
	if in.Flag("dry-run") {
		run.Log(fmt.Sprintf("Would import %s (id=%s, state=%s)", label, id, deref(document.Text("importState"), dash)))
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
	run.Log(fmt.Sprintf("%s: %s -> %s%s", label, deref(document.Text("importState"), "?"), deref(updated.Text("importState"), "?"), mark))

	// Best-effort: show the register row when Falco has finished creating it.
	var invoice *jsvalue.Object
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
		run.Log(fmt.Sprintf("  invoice register: %s  id=%s", describeInvoice(invoice), deref(invoice.Text("id"), "undefined")))
	} else if confirmed {
		run.Log("  invoice register: not visible yet (import accepted)")
	}

	out := jsvalue.NewObject()
	out.Set("document", updated)
	if invoice != nil {
		out.Set("invoice", invoice)
	} else {
		out.Set("invoice", nil)
	}
	res := record{value: out, asJSON: asJSON}
	if !confirmed {
		return res, run.Fail("API_ERROR",
			"Falco accepted the import but importState is "+deref(updated.Text("importState"), "unknown"),
			"Re-run with the same ref to confirm, or check the Falco purchase-invoices view")
	}
	return res, nil
}

// markPaidTarget is either an invoice-register row or a Peppol inbox row.
type markPaidTarget struct {
	invoice, document *jsvalue.Object
}

// resolveMarkPaidTarget prefers the local invoice register and falls back to
// the Peppol inbox when the register has no match: organizations that import
// Peppol documents into a fiduciary never see them under /document/invoices.
func resolveMarkPaidTarget(ref string, invoices, peppolDocuments []*jsvalue.Object) (markPaidTarget, error) {
	var invoiceMatches []*jsvalue.Object
	for _, i := range invoices {
		if is(i, "id", ref) || is(i, "peppolInvoiceId", ref) || is(i, "invoiceReference", ref) {
			invoiceMatches = append(invoiceMatches, i)
		}
	}
	if len(invoiceMatches) > 1 {
		lines := make([]string, len(invoiceMatches))
		for n, i := range invoiceMatches {
			lines[n] = fmt.Sprintf("  %s  id=%s  peppol=%s", deref(i.Text("invoiceReference"), "(no ref)"),
				deref(i.Text("id"), "undefined"), deref(i.Text("peppolInvoiceId"), "-"))
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

	var peppolMatches []*jsvalue.Object
	for _, d := range peppolDocuments {
		if matchesPeppolRef(d, ref) {
			peppolMatches = append(peppolMatches, d)
		}
	}
	if len(peppolMatches) > 1 {
		lines := make([]string, len(peppolMatches))
		for n, d := range peppolMatches {
			lines[n] = fmt.Sprintf("  %s  id=%s  fiduciary=%s", noRef(d), deref(d.Text("id"), "undefined"), deref(d.Text("fiduciaryDocumentId"), "-"))
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

// markPaidStatus validates what was typed before --unpaid overrides it, so a
// bad --status is never silently discarded by the shortcut.
func markPaidStatus(in plugins.CommandInput, fail plugins.FailFunc) (string, error) {
	status := in.Option("status")
	if status != "Paid" && status != "NotPaid" {
		return "", fail("INVALID_PARAMS", "--status must be Paid or NotPaid, got: "+status, "")
	}
	if in.Flag("unpaid") {
		status = "NotPaid"
	}
	return status, nil
}

func runMarkPaid(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	status := plugins.Prepared[string](run)
	asJSON := in.Option("format") == "json"
	ref := in.Arg("ref")
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
	var peppolDocuments []*jsvalue.Object
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
		reread = func() ([]*jsvalue.Object, error) { return c.listAllPeppolDocuments(nil) }
	}
	id := deref(row.Text("id"), "undefined")

	if is(row, "paymentStatus", status) {
		run.Log(fmt.Sprintf("%s is already %s; nothing to do.", label, status))
		return record{value: row, asJSON: asJSON}, nil
	}
	if err := write(id, status); err != nil {
		return nil, failed(run.Fail, err)
	}

	// The write has landed. Everything below only confirms it, so a failure
	// here must never be reported as though the change did not happen.
	var updated *jsvalue.Object
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
		to = deref(updated.Text("paymentStatus"), status)
	}
	run.Log(paymentStatusChange(label, row.Text("paymentStatus"), to, confirmed))

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
