---
name: agentio-falco
description: Use when interacting with Falco accounting and Peppol documents via the agentio CLI.
---

# Falco via agentio

Auto-generated from `agentio skill falco`. Do not edit by hand.

## agentio falco peppol list

List inbound Peppol documents

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--since <date>`: Only documents dated on or after YYYY-MM-DD
- `--sender <text>`: Only documents whose supplier name or VAT number contains this
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # everything in the inbox
  agentio falco peppol list

  # this quarter, from one supplier
  agentio falco peppol list --since 2026-07-01 --sender BE0123456789

  # machine-readable
  agentio falco peppol list --format json
```

## agentio falco peppol get <id>

Download the UBL XML of one Peppol document

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--output <path>`: File, directory, or "-" for stdout (default: <id>.xml)
- `--extract-pdf`: Also write a PDF next to the XML

```
Examples:

  # write <id>.xml into the working directory
  agentio falco peppol get 7f2c1e90-...

  # XML plus a PDF, into a folder
  agentio falco peppol get 7f2c1e90-... --output ./inbox --extract-pdf

  # pipe the XML somewhere else
  agentio falco peppol get 7f2c1e90-... --output -
```

## agentio falco peppol sync

Download every matching Peppol document into a directory

Options:

- `--output <dir>`: Target directory (created if missing)
- `--profile <name>`: Profile name (optional if only one profile exists)
- `--since <date>`: Only documents dated on or after YYYY-MM-DD
- `--sender <text>`: Only documents whose supplier name or VAT number contains this
- `--extract-pdf`: Ensure a PDF exists for every document
- `--force`: Re-download documents already on disk

```
Examples:

  # mirror the whole inbox, XML only
  agentio falco peppol sync --output ./peppol

  # XML plus PDFs, this year only
  agentio falco peppol sync --output ./peppol --since 2026-01-01 --extract-pdf

  # re-download everything
  agentio falco peppol sync --output ./peppol --force
```

## agentio falco peppol mark-paid <ref>

Set the payment status of an invoice

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--status <status>`: Paid or NotPaid (default: Paid)
- `--unpaid`: Shortcut for --status NotPaid
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # mark an invoice paid, by reference
  agentio falco peppol mark-paid INV-2026-0042

  # undo it
  agentio falco peppol mark-paid INV-2026-0042 --unpaid

  # by Peppol document id, printing the updated record
  agentio falco peppol mark-paid 7f2c1e90-... --format json
```

## agentio falco invoices sync

Download outbound billing document PDFs into a directory

Options:

- `--output <dir>`: Target directory (created if missing)
- `--profile <name>`: Profile name (optional if only one profile exists)
- `--since <date>`: Only documents sent or created on or after YYYY-MM-DD
- `--customer <text>`: Only documents whose customer name contains this
- `--include <types>`: Comma-separated document types (default: Invoice,CreditNote)
- `--force`: Re-download documents already on disk

```
Examples:

  # every sales invoice and credit note
  agentio falco invoices sync --output ./sales

  # invoices only, since the start of the quarter
  agentio falco invoices sync --output ./sales --include Invoice --since 2026-07-01

  # one customer
  agentio falco invoices sync --output ./sales --customer "Acme"
```
