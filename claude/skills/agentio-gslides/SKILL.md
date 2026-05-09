---
name: agentio-gslides
description: Use when interacting with gslides via the agentio CLI.
---

# Gslides via agentio

Auto-generated from `agentio skill gslides`. Do not edit by hand.

## agentio gslides list

List recent presentations

Options:

- `--profile <name>`: Profile name
- `--limit <n>`: Number of presentations (default: 10)
- `--query <query>`: Drive search query filter

```
Examples:

  # 10 most recently modified presentations
  agentio gslides list

  # presentations you own
  agentio gslides list --query "'me' in owners" --limit 50

  # search by name fragment
  agentio gslides list --query "name contains 'Q4'"

  # recently modified
  agentio gslides list --query "modifiedTime > '2024-01-01'"

Query syntax: name contains '...', name = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD'. Combine with 'and'/'or'.
```

## agentio gslides metadata <id-or-url>

Get presentation structure (slide count, dimensions, slide titles)

Options:

- `--profile <name>`: Profile name

```
Examples:

  # slide count, dimensions, slide titles
  agentio gslides metadata 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # accept a full URL
  agentio gslides metadata https://docs.google.com/presentation/d/1A2bCdEf.../edit
```

## agentio gslides get <id-or-url>

Read slide content as text (all slides or one by index)

Options:

- `--profile <name>`: Profile name
- `--slide <n>`: Zero-based slide index to read (omit for all slides)

```
Examples:

  # read all slides as text
  agentio gslides get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # read only slide 0 (first slide)
  agentio gslides get 1A2bCdEf... --slide 0

  # accept a full URL
  agentio gslides get https://docs.google.com/presentation/d/1A2bCdEf.../edit

Output includes text elements and speaker notes for each slide.
```

## agentio gslides export <id-or-url>

Export a presentation to a file

Options:

- `--profile <name>`: Profile name
- `--output <path>`: Output file path
- `--format <fmt>`: Export format: pptx, pdf, or odp (default: pptx)

```
Examples:

  # default pptx export
  agentio gslides export 1A2bCdEf... --output deck.pptx

  # PDF
  agentio gslides export 1A2bCdEf... --output deck.pdf --format pdf

  # ODP (LibreOffice)
  agentio gslides export 1A2bCdEf... --output deck.odp --format odp

Formats: pptx (default), pdf, odp.
```

## agentio gslides create <title>

Create a new blank presentation

Options:

- `--profile <name>`: Profile name

```
Examples:

  # create a blank presentation
  agentio gslides create "Q4 Review"

  # with a specific profile
  agentio gslides create "Team Deck" --profile work@example.com
```

## agentio gslides copy <id-or-url> <title>

Copy a presentation

Options:

- `--profile <name>`: Profile name
- `--parent <folder-id>`: Destination folder ID

```
Examples:

  # duplicate to My Drive root
  agentio gslides copy 1A2bCdEf... "Q4 Review (copy)"

  # duplicate into a specific folder
  agentio gslides copy 1A2bCdEf... "Q4 Review (copy)" --parent 1FoLdErIdAbCd...
```

## agentio gslides batch <id-or-url>

Execute raw presentations.batchUpdate requests (escape hatch)

Options:

- `--profile <name>`: Profile name
- `--requests-json <json>`: Inline JSON array of Request objects
- `--file <path>`: Path to a JSON file containing the requests array

```
Examples:

  # insert a new blank slide at the end (inline JSON)
  agentio gslides batch 1A2bCdEf... --requests-json '[{"createSlide":{"insertionIndex":999,"slideLayoutReference":{"predefinedLayout":"BLANK"}}}]'

  # from a file
  agentio gslides batch 1A2bCdEf... --file ./requests.json

Accepts an array of Slides API Request objects. See:
https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate
```
