---
name: agentio-gdocs
description: Use when interacting with Google Docs via the agentio CLI - list, read, create.
---

# Gdocs via agentio

Auto-generated from `agentio skill gdocs`. Do not edit by hand.

## agentio gdocs get <doc-id-or-url>

Export a document

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Export format: markdown or docx (default: markdown)
- `--output <file>`: Output file path (required for docx, optional for markdown)

```
Examples:

  # print a document as markdown to stdout
  agentio gdocs get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # accept a full Google Docs URL
  agentio gdocs get https://docs.google.com/document/d/1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit

  # save markdown to a file
  agentio gdocs get 1A2bCdEf... --output report.md

  # export to .docx (requires --output)
  agentio gdocs get 1A2bCdEf... --format docx --output report.docx
```

## agentio gdocs create

Create a new document from Markdown

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--title <title>`: Document title
- `--content <text>`: Markdown content (or pipe via stdin)
- `--folder <folder-id>`: Folder ID to create the document in

```
Examples:

  # create a doc with inline markdown content
  agentio gdocs create --title "Meeting Notes" --content "# Agenda\n- Topic 1\n- Topic 2"

  # create a doc with body piped from a file
  cat draft.md | agentio gdocs create --title "Q4 Plan"

  # create inside a specific Drive folder
  agentio gdocs create --title "Spec" --content "# Spec" --folder 1A2bCdEfGhIjKlMnOpQrStUvWxYz
```

## agentio gdocs list

List recent documents

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Number of documents (default: 10)
- `--query <query>`: Drive search query filter

```
Examples:

  # 10 most recently modified docs
  agentio gdocs list

  # docs you own, more results
  agentio gdocs list --limit 50 --query "'me' in owners"

  # search by name fragment
  agentio gdocs list --query "name contains 'report'"

  # recently modified docs since a date
  agentio gdocs list --query "modifiedTime > '2024-01-01'"

Query syntax: name contains '...', name = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD', starred = true, trashed = false.
Combine with 'and'/'or'.
```

