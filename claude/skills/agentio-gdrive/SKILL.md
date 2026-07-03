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
- `--public`: Share with anyone as reader after upload (shorthand for share --anyone)

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

  # upload an image and make it publicly accessible (for Docs/Slides API image insertion)
  agentio gdrive put banner.png --public

Conversion: docx/doc/odt/txt/html/rtf -> Google Doc,
xlsx/xls/ods/csv/tsv -> Google Sheet, pptx/ppt/odp -> Google Slides.
```

## agentio gdrive copy <file-id-or-url>

Copy a file (server-side clone via Drive API)

Options:

- `--profile <name>`: Profile name
- `--name <name>`: Title for the copy (default: "Copy of <original>")
- `--folder <id>`: Destination folder ID (default: same as source)

```
Examples:

  # clone a Google Doc into the same folder (default name: "Copy of ...")
  agentio gdrive copy 1A2bCdEf...

  # clone with a custom title
  agentio gdrive copy 1A2bCdEf... --name "Q2 report (working copy)"

  # clone into a different folder
  agentio gdrive copy 1A2bCdEf... --folder 1XyZaBc...

  # clone with custom title into a specific folder
  agentio gdrive copy https://docs.google.com/document/d/1A2bCdEf.../edit \
    --name "Draft v2" --folder 1XyZaBc...

Server-side copy preserves layout, smart chips, and native blocks
exactly — no re-rendering. Comments are not carried over.
```

## agentio gdrive permissions <file-id-or-url>

List permissions on a file

Options:

- `--profile <name>`: Profile name

```
Examples:

  # list all permissions on a file
  agentio gdrive permissions 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789
```

## agentio gdrive share <file-id-or-url>

Share a file by creating a permission

Options:

- `--profile <name>`: Profile name
- `--anyone`: Share via link (type=anyone)
- `--user <email>`: Share with a specific user
- `--domain <domain>`: Share with an entire domain
- `--group <email>`: Share with a group
- `--role <role>`: Permission role: reader, commenter, writer (default: reader)
- `--notify`: Send notification email (default: off)
- `--message <text>`: Message body for notification email (requires --notify)
- `--allow-discovery`: Make file findable via search (only with --anyone)

```
Examples:

  # make a file publicly accessible via link (e.g. for Docs/Slides API image insertion)
  agentio gdrive share 1A2bCdEf... --anyone

  # share with a specific user as writer
  agentio gdrive share 1A2bCdEf... --user alice@example.com --role writer

  # share with a user and send a notification email
  agentio gdrive share 1A2bCdEf... --user alice@example.com --notify --message "Here's the file"

  # share with an entire domain
  agentio gdrive share 1A2bCdEf... --domain example.com --role reader

  # make publicly discoverable via search
  agentio gdrive share 1A2bCdEf... --anyone --allow-discovery
```

## agentio gdrive unshare <file-id-or-url>

Remove a permission from a file

Options:

- `--profile <name>`: Profile name
- `--permission-id <id>`: Permission ID to remove
- `--anyone`: Remove the anyone-with-link permission

```
Examples:

  # remove anyone-with-link access
  agentio gdrive unshare 1A2bCdEf... --anyone

  # remove a specific permission by ID
  agentio gdrive unshare 1A2bCdEf... --permission-id AKioiA...
```
