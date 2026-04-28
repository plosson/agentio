---
name: agentio-gdrive
description: Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation.
---

# Gdrive via agentio

Auto-generated from `agentio skill gdrive`. Do not edit by hand.

## agentio gdrive list

List files

Options:

- `--profile <name>`: Profile name
- `--limit <n>`: Number of files (default: 20)
- `--folder <id>`: Folder ID to list (use "root" for root folder)
- `--query <query>`: Drive API query filter
- `--order <field>`: Order by field (default: modifiedTime desc)
- `--trash`: Include trashed files

```
Examples:

  # 20 most recently modified files
  agentio gdrive list

  # files inside a specific folder
  agentio gdrive list --folder 1A2bCdEfGhIjKlMnOpQrStUvWxYz

  # only PDFs
  agentio gdrive list --query "mimeType = 'application/pdf'"

  # files you own, sorted by name
  agentio gdrive list --query "'me' in owners" --order "name"

Query syntax: name contains '...', mimeType = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD', starred = true, shared = true.
Combine with 'and'/'or'.
```

## agentio gdrive folders

List folders

Options:

- `--profile <name>`: Profile name
- `--limit <n>`: Number of folders (default: 20)
- `--parent <id>`: Parent folder ID (use "root" for root folder)
- `--query <query>`: Additional query filter

```
Examples:

  # 20 most recent folders
  agentio gdrive folders

  # folders directly under My Drive root
  agentio gdrive folders --parent root

  # subfolders of a specific folder
  agentio gdrive folders --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz

  # filter by name
  agentio gdrive folders --query "name contains 'archive'"
```

## agentio gdrive get <file-id-or-url>

Get file metadata

Options:

- `--profile <name>`: Profile name

```
Examples:

  # metadata by file ID
  agentio gdrive get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # metadata from a full Drive URL
  agentio gdrive get https://drive.google.com/file/d/1A2bCdEf.../view
```

## agentio gdrive search

Search for files

Options:

- `--query <text>`: Search text (searches name and content)
- `--profile <name>`: Profile name
- `--limit <n>`: Number of results (default: 20)
- `--type <mime>`: Filter by MIME type
- `--folder <id>`: Search within folder

```
Examples:

  # full-text search across name and content
  agentio gdrive search --query "quarterly report"

  # only PDFs containing the phrase
  agentio gdrive search --query "invoice" --type application/pdf

  # restrict to a folder, return more results
  agentio gdrive search --query "design" --folder 1A2bCdEf... --limit 50
```

## agentio gdrive download <file-id-or-url>

Download a file (or export Google Workspace files)

Options:

- `--profile <name>`: Profile name
- `--output <path>`: Output file path
- `--export <format>`: Export format for Google Workspace files (pdf, docx, xlsx, csv, pptx, txt, etc.)

```
Examples:

  # download a binary file as-is
  agentio gdrive download 1A2bCdEf... --output ./photo.jpg

  # export a Google Doc as PDF
  agentio gdrive download 1A2bCdEf... --output report.pdf --export pdf

  # export a Google Sheet as CSV
  agentio gdrive download 1A2bCdEf... --output data.csv --export csv

  # export Google Slides as PowerPoint
  agentio gdrive download 1A2bCdEf... --output deck.pptx --export pptx

Export formats: Docs -> pdf|docx|odt|txt|html|rtf, Sheets -> xlsx|csv|pdf|ods|tsv,
Slides -> pptx|pdf|odp|txt, Drawing -> pdf|png|jpeg|svg.
```

## agentio gdrive put <file-path>

Upload a file to Google Drive

Options:

- `--profile <name>`: Profile name
- `--name <name>`: Name for the file in Drive (defaults to local filename)
- `--folder <id>`: Folder ID to upload to
- `--type <mime>`: MIME type (auto-detected if not specified)
- `--convert`: Convert to Google Workspace format (Doc, Sheet, or Slides)

```
Examples:

  # upload a file to My Drive root
  agentio gdrive put ./report.pdf

  # upload into a specific folder with a custom name
  agentio gdrive put ./out.csv --folder 1A2bCdEf... --name "results.csv"

  # upload and convert .docx to a native Google Doc
  agentio gdrive put report.docx --convert

  # upload and convert .xlsx to a native Google Sheet
  agentio gdrive put data.xlsx --convert

Conversion: docx/doc/odt/txt/html/rtf -> Google Doc,
xlsx/xls/ods/csv/tsv -> Google Sheet, pptx/ppt/odp -> Google Slides.
```

