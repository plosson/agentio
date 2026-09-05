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

## agentio gdocs structure <doc-id-or-url>

Dump the full Docs API document representation as JSON

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--tab <tab-id>`: Return only this tab (indices are relative to the tab)
- `--all-tabs`: Include the content of every tab under .tabs[]

```
Examples:

  # dump full document structure (segment IDs, named styles, body indices, headers, footers)
  agentio gdocs structure 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # extract the headerId after a createHeader batchUpdate
  agentio gdocs structure 1A2bCdEf... | jq '.headers | keys'

  # get body content with indices
  agentio gdocs structure 1A2bCdEf... | jq '.body.content'

  # body content of one tab (find the ID with: agentio gdocs tabs)
  agentio gdocs structure 1A2bCdEf... --tab t.4cykv13flp0m | jq '.body.content'

  # every tab's content in one payload
  agentio gdocs structure 1A2bCdEf... --all-tabs | jq '.tabs[].tabProperties'

Without --tab or --all-tabs, only the first tab is returned (Docs API default).
Indices from --tab are relative to that tab: pass the same tabId in the
location/range of every batch request that writes to it.
```

## agentio gdocs tabs <doc-id-or-url>

List the tabs of a document (ID, title, nesting)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # list every tab with its ID
  agentio gdocs tabs 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # a tab ID also appears in the browser URL as ?tab=t.xxxx
  agentio gdocs tabs https://docs.google.com/document/d/1A2bCdEf.../edit

Tab IDs feed --tab on 'structure' and the location.tabId / range.tabId
fields of 'batch' requests.
```

## agentio gdocs batch <doc-id-or-url>

Execute raw documents.batchUpdate requests (escape hatch)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--requests-json <json>`: Inline JSON array of batchUpdate requests
- `--file <path>`: Path to a JSON file containing the requests array

```
Examples:

  # apply bold to a range of text (start/end offsets from the document body)
  agentio gdocs batch 1A2bCdEf... --requests-json '[{"updateTextStyle":{"range":{"startIndex":1,"endIndex":10},"textStyle":{"bold":true},"fields":"bold"}}]'

  # load requests from a file
  agentio gdocs batch 1A2bCdEf... --file ./requests.json

  # write into a specific tab (indices come from: agentio gdocs structure --tab)
  agentio gdocs batch 1A2bCdEf... --requests-json '[{"insertText":{"location":{"index":1,"tabId":"t.4cykv13flp0m"},"text":"Hello"}}]'

In a multi-tab document every location/range must carry the tabId, otherwise
the request lands in the first tab.

Accepts an array of Docs API Request objects. See:
https://developers.google.com/docs/api/reference/rest/v1/documents/request
```

