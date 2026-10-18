---
name: agentio-gdrive
description: Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation.
---

# Google Drive via agentio

Auto-generated from `agentio skill gdrive`. Do not edit by hand.

## agentio gdrive list

List files

Options:

- `--profile <name>`: Profile name
- `--limit <n>`: Number of files (default: 20; no limit with --recursive)
- `--folder <id>`: Folder ID or URL to list (use "root" for root folder)
- `--query <query>`: Drive API query filter
- `--order <field>`: Order by field (default: modifiedTime desc; folder,name with --recursive)
- `--trash`: Include trashed files
- `--recursive`: Walk every subfolder too, printing each item with its path
- `--max-depth <n>`: With --recursive: deepest level to list (1 = direct children only)
- `--follow-shortcuts`: With --recursive: also walk folders that shortcuts point at (cycles are cut)
- `--fields <list>`: Extra fields on each item's second text line: md5,bytes,modified,created,mime,owners,parents,path,link,target
- `--json`: Output JSON for programs to read

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

  # with MD5 and exact byte size on each item
  agentio gdrive list --folder 1A2bCdEf... --fields md5,bytes,modified

  # everything below a folder, with paths, as JSON (md5Checksum is null for native Docs/Sheets/Slides)
  agentio gdrive list --folder 1A2bCdEf... --recursive --json

  # two levels deep, only PDFs, also walking folder shortcuts
  agentio gdrive list --folder 1A2bCdEf... --recursive --max-depth 2 --follow-shortcuts --query "mimeType = 'application/pdf'"

Query syntax: name contains '...', mimeType = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD', starred = true, shared = true.
Combine with 'and'/'or'. With --recursive, --query filters what is listed;
every subfolder is still walked.
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

Get file metadata (including MD5 and exact size)

Options:

- `--profile <name>`: Profile name
- `--json`: Output JSON for programs to read

```
Examples:

  # metadata by file ID
  agentio gdrive get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # metadata from a full Drive URL
  agentio gdrive get https://drive.google.com/file/d/1A2bCdEf.../view

  # as JSON, e.g. to compare md5Checksum with a local file
  agentio gdrive get 1A2bCdEf... --json
```

## agentio gdrive search

Search for files

Options:

- `--query <text>`: Search text (searches name and content)
- `--profile <name>`: Profile name
- `--limit <n>`: Number of results (default: 20)
- `--type <mime>`: Filter by MIME type
- `--folder <id>`: Search within folder
- `--fields <list>`: Extra fields on each item's second text line: md5,bytes,modified,created,mime,owners,parents,path,link,target
- `--json`: Output JSON for programs to read

```
Examples:

  # full-text search across name and content
  agentio gdrive search --query "quarterly report"

  # only PDFs containing the phrase
  agentio gdrive search --query "invoice" --type application/pdf

  # restrict to a folder, return more results
  agentio gdrive search --query "design" --folder 1A2bCdEf... --limit 50

  # with MD5 and byte size, or as JSON
  agentio gdrive search --query "invoice" --fields md5,bytes
  agentio gdrive search --query "invoice" --json
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

## agentio gdrive mkdir <name>

Create a folder

Options:

- `--profile <name>`: Profile name
- `--parent <id>`: Parent folder ID or URL (default: My Drive root)

```
Examples:

  # create a folder in My Drive root
  agentio gdrive mkdir "Reports"

  # create a subfolder inside an existing folder
  agentio gdrive mkdir "2026" --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz
```

## agentio gdrive rename <file-id-or-url> <new-name>

Rename a file or folder

Options:

- `--profile <name>`: Profile name

```
Examples:

  # rename a file by ID
  agentio gdrive rename 1A2bCdEfGhIjKlMnOpQrStUvWxYz "report-final.pdf"

  # rename a folder from a full Drive URL
  agentio gdrive rename https://drive.google.com/drive/folders/1A2bCdEf... "Archive 2025"
```

## agentio gdrive move [ids...]

Move one or many files or folders to another folder

Options:

- `--profile <name>`: Profile name
- `--to <folder-id>`: Destination folder ID or URL for every ID given (use "root" for My Drive root)
- `--batch <file>`: CSV of fileId,destFolderId lines ("-" for stdin; header, blank and # lines skipped)
- `--chunk <n>`: Calls per Drive batch request (1-100) (default: 50)
- `--dry-run`: Look up current parents and report what would move, without moving

```
Examples:

  # move a file into a folder
  agentio gdrive move 1A2bCdEfGhIjKlMnOpQrStUvWxYz 1XyZaBcDeFgHiJkLmNoPqRsTuVw

  # move a folder (and its contents) into another folder
  agentio gdrive move https://drive.google.com/drive/folders/1A2bCdEf... 1XyZaBc...

  # move a file back to My Drive root
  agentio gdrive move 1A2bCdEfGhIjKlMnOpQrStUvWxYz root

  # move several files into one folder (batched)
  agentio gdrive move 1AaA... 1BbB... 1CcC... --to 1XyZaBc...

  # move from a CSV of fileId,destFolderId lines
  agentio gdrive move --batch moves.csv

  # same, from stdin, checking first without moving anything
  cat moves.csv | agentio gdrive move --batch - --dry-run

Batch moves print one JSON line per file ({fileId, dest, status: ok|error,
error?}) and a final {summary} line, and exit 5 if any file failed.
Calls are sent through Drive's batch endpoint (--chunk per request, max 100);
rate-limit (403/429) and 5xx answers are retried with exponential backoff.
```

## agentio gdrive shortcut [target-id-or-url]

Create Drive shortcuts to files or folders

Options:

- `--profile <name>`: Profile name
- `--parent <folder-id>`: Folder to put the shortcut in (use "root" for My Drive root)
- `--name <name>`: Shortcut name (default: the target's name)
- `--batch <file>`: CSV of targetId,parentId[,name] lines ("-" for stdin; header, blank and # lines skipped)
- `--chunk <n>`: Calls per Drive batch request (1-100) (default: 50)
- `--allow-duplicates`: Create even if a shortcut to the same target is already in the parent
- `--dry-run`: Check that targets and parents are accessible, without creating anything

```
Examples:

  # shortcut to a file shared with you, in one of your folders (named like the target)
  agentio gdrive shortcut https://docs.google.com/document/d/1A2bCdEf.../edit --parent 1XyZaBc...

  # with a custom name, in My Drive root
  agentio gdrive shortcut 1A2bCdEf... --parent root --name "Team budget"

  # many at once from a CSV of targetId,parentId[,name] lines
  agentio gdrive shortcut --batch shortcuts.csv

  # check first, from stdin
  cat shortcuts.csv | agentio gdrive shortcut --batch - --dry-run

Prints one JSON line per shortcut ({targetId, parent, status: ok|error,
name, shortcutId?, existing?, error?}) and a final {summary} line; exits 5
if any failed. A shortcut to the same target already in the parent is
reported (existing: true) instead of created, unless --allow-duplicates.
```

## agentio gdrive trash <file-id-or-url>

Move a file to the trash

Options:

- `--profile <name>`: Profile name

```
Examples:

  # move a file to the trash by ID
  agentio gdrive trash 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # move a file to the trash from a full Drive URL
  agentio gdrive trash https://docs.google.com/document/d/1A2bCdEf.../edit

Trashed files stay recoverable in Drive's trash for 30 days
before Google deletes them permanently.
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

