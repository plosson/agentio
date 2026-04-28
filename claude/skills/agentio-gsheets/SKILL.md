---
name: agentio-gsheets
description: Use when interacting with Google Sheets via the agentio CLI.
---

# Gsheets via agentio

Auto-generated from `agentio skill gsheets`. Do not edit by hand.

## agentio gsheets list

List recent spreadsheets

Options:

- `--profile <name>`: Profile name
- `--limit <n>`: Number of spreadsheets (default: 10)
- `--query <query>`: Drive search query filter

```
Examples:

  # 10 most recently modified spreadsheets
  agentio gsheets list

  # spreadsheets you own
  agentio gsheets list --query "'me' in owners" --limit 50

  # search by name fragment
  agentio gsheets list --query "name contains 'budget'"

  # recently modified
  agentio gsheets list --query "modifiedTime > '2024-01-01'"

Query syntax: name contains '...', name = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD'. Combine with 'and'/'or'.
```

## agentio gsheets get <spreadsheet-id-or-url> <range>

Get values from a range

Options:

- `--profile <name>`: Profile name
- `--dimension <dim>`: Major dimension: ROWS or COLUMNS
- `--render <opt>`: Value render: FORMATTED_VALUE, UNFORMATTED_VALUE, or FORMULA

```
Examples:

  # read a 2x3 block on Sheet1
  agentio gsheets get 1A2bCdEf... "Sheet1!A1:C2"

  # entire column B
  agentio gsheets get 1A2bCdEf... "Sheet1!B:B"

  # show formulas instead of computed values
  agentio gsheets get 1A2bCdEf... "Sheet1!A1:D10" --render FORMULA

  # major dimension: COLUMNS (transposes orientation)
  agentio gsheets get 1A2bCdEf... "Sheet1!A1:C10" --dimension COLUMNS
```

## agentio gsheets update <spreadsheet-id-or-url> <range> [values...]

Update values in a range

Options:

- `--profile <name>`: Profile name
- `--values-json <json>`: Values as JSON 2D array
- `--input <opt>`: Value input option: RAW or USER_ENTERED (default: USER_ENTERED)

```
Examples:

  # set a 2x2 block via simple format (',' = new row, '|' = new cell)
  agentio gsheets update 1A2bCdEf... "Sheet1!A1:B2" "a|b,c|d"

  # same write via JSON
  agentio gsheets update 1A2bCdEf... "Sheet1!A1:B2" --values-json '[["a","b"],["c","d"]]'

  # store raw text without formula parsing
  agentio gsheets update 1A2bCdEf... "Sheet1!A1" "=SUM(B:B)" --input RAW

  # write a formula that gets evaluated
  agentio gsheets update 1A2bCdEf... "Sheet1!A1" "=SUM(B:B)" --input USER_ENTERED

Input options: RAW (stored as-is), USER_ENTERED (parsed like typed in UI).
```

## agentio gsheets append <spreadsheet-id-or-url> <range> [values...]

Append values to a range

Options:

- `--profile <name>`: Profile name
- `--values-json <json>`: Values as JSON 2D array
- `--input <opt>`: Value input option: RAW or USER_ENTERED (default: USER_ENTERED)
- `--insert <opt>`: Insert data option: OVERWRITE or INSERT_ROWS

```
Examples:

  # append two rows to columns A-C
  agentio gsheets append 1A2bCdEf... "Sheet1!A:C" "alice|10|us,bob|7|fr"

  # append via JSON
  agentio gsheets append 1A2bCdEf... "Sheet1!A:C" --values-json '[["a","b","c"],["d","e","f"]]'

  # insert new rows instead of overwriting blanks below the table
  agentio gsheets append 1A2bCdEf... "Sheet1!A:C" "x|y|z" --insert INSERT_ROWS

Insert: OVERWRITE writes into existing cells, INSERT_ROWS shifts rows down.
```

## agentio gsheets clear <spreadsheet-id-or-url> <range>

Clear values in a range

Options:

- `--profile <name>`: Profile name

```
Examples:

  # clear a small block
  agentio gsheets clear 1A2bCdEf... "Sheet1!A1:D10"

  # clear an entire sheet
  agentio gsheets clear 1A2bCdEf... "Sheet1!A1:Z1000"
```

## agentio gsheets format <spreadsheet-id-or-url> <range>

Apply cell formatting (colors, text style, alignment, borders, merge)

Options:

- `--profile <name>`: Profile name
- `--bold`: Make text bold
- `--italic`: Make text italic
- `--underline`: Underline text
- `--font-size <n>`: Font size in points
- `--font-family <name>`: Font family name (e.g., "Arial")
- `--text-color <hex>`: Text color as #rrggbb
- `--background <hex>`: Background color as #rrggbb
- `--align <pos>`: Horizontal alignment: left, center, right
- `--valign <pos>`: Vertical alignment: top, middle, bottom
- `--wrap <strategy>`: Text wrap: overflow, clip, wrap
- `--number-format <pattern>`: Number format pattern (e.g., "$#,##0.00", "0.00%")
- `--border <style>`: Borders: all, outer, none
- `--merge`: Merge the range into a single cell
- `--clear-format`: Clear existing formatting on the range first
- `--raw <json>`: Raw CellFormat JSON merged into the request

```
Examples:

  # bold header row with colored background and white text
  agentio gsheets format 1A2bCdEf... "Sheet1!A1:D1" --bold --background "#4285f4" --text-color "#ffffff"

  # currency formatting on a column
  agentio gsheets format 1A2bCdEf... "Sheet1!C2:C100" --number-format "$#,##0.00"

  # outer border around a table
  agentio gsheets format 1A2bCdEf... "Sheet1!A1:D10" --border outer

  # merge title cells with centered bold text
  agentio gsheets format 1A2bCdEf... "Sheet1!A1:D1" --merge --align center --bold

  # reset formatting on a range
  agentio gsheets format 1A2bCdEf... "Sheet1!A1:Z1000" --clear-format
```

## agentio gsheets resize <spreadsheet-id-or-url> <range>

Resize columns or rows (explicit pixel size or auto-fit)

Options:

- `--profile <name>`: Profile name
- `--size <pixels>`: Pixel size
- `--auto`: Auto-fit to content

```
Examples:

  # set columns A-C to 200px wide
  agentio gsheets resize 1A2bCdEf... "Sheet1!A:C" --size 200

  # auto-fit the header row to content
  agentio gsheets resize 1A2bCdEf... "Sheet1!1:1" --auto

  # resize a single column
  agentio gsheets resize 1A2bCdEf... "Sheet1!B:B" --size 150

Range must be columns-only (A:C) or rows-only (1:10).
--size and --auto are mutually exclusive.
```

## agentio gsheets batch <spreadsheet-id-or-url>

Execute raw spreadsheets.batchUpdate requests (escape hatch)

Options:

- `--profile <name>`: Profile name
- `--requests-json <json>`: Inline JSON array of batchUpdate requests
- `--file <path>`: Path to a JSON file containing the requests array

```
Examples:

  # freeze the first row (inline JSON)
  agentio gsheets batch 1A2bCdEf... --requests-json '[{"updateSheetProperties":{"properties":{"sheetId":0,"gridProperties":{"frozenRowCount":1}},"fields":"gridProperties.frozenRowCount"}}]'

  # from a file
  agentio gsheets batch 1A2bCdEf... --file ./requests.json

Accepts an array of Sheets API Request objects. See:
https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request
```

## agentio gsheets metadata <spreadsheet-id-or-url>

Get spreadsheet metadata

Options:

- `--profile <name>`: Profile name

```
Examples:

  # title, sheets, sheetIds, locale, etc.
  agentio gsheets metadata 1A2bCdEf...

  # accept a full URL
  agentio gsheets metadata https://docs.google.com/spreadsheets/d/1A2bCdEf.../edit
```

## agentio gsheets create <title>

Create a new spreadsheet

Options:

- `--profile <name>`: Profile name
- `--sheets <names>`: Comma-separated sheet names to create

```
Examples:

  # blank spreadsheet with default Sheet1
  agentio gsheets create "Q4 Plan"

  # multi-sheet workbook
  agentio gsheets create "Budget 2024" --sheets "Income,Expenses,Summary"
```

## agentio gsheets copy <spreadsheet-id-or-url> <title>

Copy a spreadsheet

Options:

- `--profile <name>`: Profile name
- `--parent <folder-id>`: Destination folder ID

```
Examples:

  # duplicate to My Drive root
  agentio gsheets copy 1A2bCdEf... "Q4 Plan (copy)"

  # duplicate into a specific folder
  agentio gsheets copy 1A2bCdEf... "Q4 Plan (copy)" --parent 1FoLdErIdAbCd...
```

## agentio gsheets export <spreadsheet-id-or-url>

Export a spreadsheet to a file

Options:

- `--profile <name>`: Profile name
- `--output <path>`: Output file path
- `--format <fmt>`: Export format: xlsx, pdf, csv, ods, tsv (default: xlsx)

```
Examples:

  # default xlsx export
  agentio gsheets export 1A2bCdEf... --output report.xlsx

  # CSV (first sheet only)
  agentio gsheets export 1A2bCdEf... --output data.csv --format csv

  # PDF
  agentio gsheets export 1A2bCdEf... --output report.pdf --format pdf

Formats: xlsx (default), pdf, csv, ods, tsv. csv and tsv are first sheet only.
```

