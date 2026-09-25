// Package falco is the Falco accounting and Peppol service.
package falco

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "falco",
		DisplayName: "Falco",
		Description: "Use when interacting with Falco accounting and Peppol documents via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          setup,
			Validate:       validate,
			Reauthenticate: reauth,
			ListInfo:       listInfo,
			Refresh: &plugins.RefreshSpec{
				// Withholding the refresh token is what stops a remote agent
				// minting its own access tokens; the hub refreshes for it.
				SecretFields: []string{"refreshToken"},
				Applies:      applies,
				IsStale:      stale,
				Run:          refresh,
			},
		},
		Commands: []plugins.CommandSpec{
			peppolListCmd(), peppolGetCmd(), peppolSyncCmd(), markPaidCmd(), importCmd(), invoicesSyncCmd(),
		},
	}
}

func clientOf(ctx context.Context, run *plugins.RunContext) *client {
	return newClient(ctx, run.Credentials, run.Fetch)
}

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// requireIsoDate is Bun requireIsoDate: an absent option is no filter, any
// given value (even "") must be YYYY-MM-DD.
func requireIsoDate(run *plugins.RunContext, in plugins.CommandInput, name string) (string, error) {
	value, given := in.LookupOption(name)
	if !given || isoDate.MatchString(value) {
		return value, nil
	}
	return "", run.Fail("INVALID_PARAMS", "--"+name+" must be YYYY-MM-DD, got: "+value, "")
}

func containsInsensitive(haystack *string, needle string) bool {
	return strings.Contains(strings.ToLower(deref(haystack, "")), needle)
}

// filterPeppolDocuments narrows client-side; the endpoint has no equivalents.
func filterPeppolDocuments(documents []*jsvalue.Object, since, sender string) []*jsvalue.Object {
	result := documents
	if since != "" {
		var kept []*jsvalue.Object
		for _, d := range result {
			if jsvalue.Slice(deref(d.Text("documentDate"), ""), 10) >= since {
				kept = append(kept, d)
			}
		}
		result = kept
	}
	if sender != "" {
		needle := strings.ToLower(sender)
		var kept []*jsvalue.Object
		for _, d := range result {
			if containsInsensitive(d.Text("supplierVatNumber"), needle) || containsInsensitive(d.Text("supplierName"), needle) {
				kept = append(kept, d)
			}
		}
		result = kept
	}
	return result
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// is is `value === ref` for a string ref.
func is(o *jsvalue.Object, key, ref string) bool {
	s, ok := o.Str(key)
	return ok && s == ref
}

func peppolListCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "peppol list",
		Description: "List inbound Peppol documents",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--since <date>", Description: "Only documents dated on or after YYYY-MM-DD"},
			{Flags: "--sender <text>", Description: "Only documents whose supplier name or VAT number contains this"},
			{Flags: "--format <format>", Description: "Output format: text or json", DefaultValue: "text"},
		},
		Examples: []string{
			"# everything in the inbox",
			"agentio falco peppol list",
			"# this quarter, from one supplier",
			"agentio falco peppol list --since 2026-07-01 --sender BE0123456789",
			"# machine-readable",
			"agentio falco peppol list --format json",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			since, err := requireIsoDate(run, in, "since")
			if err != nil {
				return nil, err
			}
			docs, err := clientOf(ctx, run).listPeppolDocuments(nil)
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return peppolList{documents: filterPeppolDocuments(docs, since, in.Option("sender")), asJSON: in.Option("format") == "json"}, nil
		},
		Format: formatPeppolList,
	}
}

var xmlSuffix = regexp.MustCompile(`(?i)\.xml$`)

func peppolGetCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "peppol get",
		Description: "Download the UBL XML of one Peppol document",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Peppol document ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--output <path>", Description: `File, directory, or "-" for stdout (default: <id>.xml)`},
			{Flags: "--extract-pdf", Description: "Also write a PDF next to the XML"},
		},
		Examples: []string{
			"# write <id>.xml into the working directory",
			"agentio falco peppol get 7f2c1e90-...",
			"# XML plus a PDF, into a folder",
			"agentio falco peppol get 7f2c1e90-... --output ./inbox --extract-pdf",
			"# pipe the XML somewhere else",
			"agentio falco peppol get 7f2c1e90-... --output -",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			id, output := in.Arg("id"), in.Option("output")
			payload, err := clientOf(ctx, run).downloadPeppolDocumentUbl(id)
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			xml := jsvalue.DecodeUTF8(payload)
			res := &written{Bytes: len(payload)}
			toStdout := output == "-"
			xmlPath := id + ".xml"
			if toStdout {
				res.XML = &xml
			} else {
				if output != "" {
					xmlPath = output
					if isDirectory(output) {
						xmlPath = filepath.Join(output, id+".xml")
					}
					if parent := filepath.Dir(xmlPath); parent != "" && parent != "." {
						if err := os.MkdirAll(parent, 0o777); err != nil {
							return nil, err
						}
					}
				}
				if err := os.WriteFile(xmlPath, payload, 0o666); err != nil {
					return nil, err
				}
				res.XMLPath = xmlPath
				run.Log(fileWritten(xmlPath, len(payload), ""))
			}
			if !in.Flag("extract-pdf") {
				return res, nil
			}

			// A Peppol UBL document may carry a PDF rendition; when it does not,
			// one is rendered from the parsed invoice. Streaming the XML to
			// stdout still writes the PDF into the working directory.
			pdfPath := id + ".pdf"
			if !toStdout {
				pdfPath = xmlSuffix.ReplaceAllString(xmlPath, "") + ".pdf"
			}
			var pdf []byte
			note := "rendered from UBL"
			if embedded := extractEmbeddedPdf(xml); embedded != nil {
				pdf = embedded.bytes
				note = "extracted"
				if embedded.filename != nil && *embedded.filename != "" {
					note += " [original name: " + *embedded.filename + "]"
				}
			} else if pdf, err = renderUblXMLToPdf(xml); err != nil {
				return partial(res, toStdout), err
			}
			if err := os.WriteFile(pdfPath, pdf, 0o666); err != nil {
				return partial(res, toStdout), err
			}
			n := len(pdf)
			res.PDFPath, res.PDFBytes, res.PDFNote = pdfPath, &n, note
			run.Log(fileWritten(pdfPath, n, note))
			return res, nil
		},
		Format: formatWritten,
	}
}

// partial keeps what Bun had already printed when the PDF step fails: the XML
// streamed to stdout.
func partial(res *written, toStdout bool) any {
	if toStdout {
		return res
	}
	return nil
}

func peppolSyncCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "peppol sync",
		Description: "Download every matching Peppol document into a directory",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--output <dir>", Description: "Target directory (created if missing)"},
			{Flags: "--since <date>", Description: "Only documents dated on or after YYYY-MM-DD"},
			{Flags: "--sender <text>", Description: "Only documents whose supplier name or VAT number contains this"},
			{Flags: "--extract-pdf", Description: "Ensure a PDF exists for every document"},
			{Flags: "--force", Description: "Re-download documents already on disk"},
		},
		Examples: []string{
			"# mirror the whole inbox, XML only",
			"agentio falco peppol sync --output ./peppol",
			"# XML plus PDFs, this year only",
			"agentio falco peppol sync --output ./peppol --since 2026-01-01 --extract-pdf",
			"# re-download everything",
			"agentio falco peppol sync --output ./peppol --force",
		},
		Run:    runPeppolSync,
		Format: formatSync,
	}
}

func markPaidCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "peppol mark-paid",
		Description: "Set the payment status of an invoice",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(checkStatus),
		Operation:   "mark an invoice as paid",
		Arguments:   []plugins.ArgumentSpec{{Name: "ref", Description: "Peppol document ID, invoice ID, invoice reference, or fiduciary document ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--status <status>", Description: "Paid or NotPaid", DefaultValue: "Paid"},
			{Flags: "--unpaid", Description: "Shortcut for --status NotPaid"},
			{Flags: "--format <format>", Description: "Output format: text or json", DefaultValue: "text"},
		},
		Examples: []string{
			"# mark an invoice paid, by reference",
			"agentio falco peppol mark-paid INV-2026-0042",
			"# undo it",
			"agentio falco peppol mark-paid INV-2026-0042 --unpaid",
			"# by Peppol document id, printing the updated record",
			"agentio falco peppol mark-paid 7f2c1e90-... --format json",
		},
		Run:    runMarkPaid,
		Format: formatRecord,
	}
}

func importCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "peppol import",
		Description: "Import a Peppol document into the Falco invoice register",
		Access:      "write",
		Operation:   "import a Peppol document into the invoice register",
		// A dry run writes nothing, so Bun skips the write check for it.
		AccessFor: func(in plugins.CommandInput) string {
			if in.Flag("dry-run") {
				return "read"
			}
			return "write"
		},
		Arguments: []plugins.ArgumentSpec{{Name: "ref", Description: "Peppol document ID, invoice reference, document number, or fiduciary document ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--dry-run", Description: "Resolve the document and report what would be imported, without writing"},
			{Flags: "--format <format>", Description: "Output format: text or json", DefaultValue: "text"},
		},
		Examples: []string{
			"# import one inbox document into /document/invoices",
			"agentio falco peppol import 7f2c1e90-...",
			"# by invoice reference",
			"agentio falco peppol import DT20261730 --profile letschill-srl",
			"# show the match without writing",
			"agentio falco peppol import DT20261730 --dry-run",
		},
		Run:    runPeppolImport,
		Format: formatRecord,
	}
}

func invoicesSyncCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "invoices sync",
		Description: "Download outbound billing document PDFs into a directory",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--output <dir>", Description: "Target directory (created if missing)"},
			{Flags: "--since <date>", Description: "Only documents sent or created on or after YYYY-MM-DD"},
			{Flags: "--customer <text>", Description: "Only documents whose customer name contains this"},
			{Flags: "--include <types>", Description: "Comma-separated document types", DefaultValue: "Invoice,CreditNote"},
			{Flags: "--force", Description: "Re-download documents already on disk"},
		},
		Examples: []string{
			"# every sales invoice and credit note",
			"agentio falco invoices sync --output ./sales",
			"# invoices only, since the start of the quarter",
			"agentio falco invoices sync --output ./sales --include Invoice --since 2026-07-01",
			"# one customer",
			`agentio falco invoices sync --output ./sales --customer "Acme"`,
		},
		Run:    runInvoicesSync,
		Format: formatSync,
	}
}
