// Package gsheets is the Google Sheets service.
package gsheets

import (
	"context"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "gsheets",
		DisplayName: "Google Sheets",
		Description: "Use when interacting with Google Sheets via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          google.Setup("gsheets", "Google Sheets"),
			Validate:       google.ValidateDriveFiles(sheetMimeType),
			Reauthenticate: google.Reauthenticate("gsheets", google.Camel),
			Refresh:        google.Camel.RefreshSpec(),
			ListInfo:       google.EmailListInfo,
		},
		Commands: []plugins.CommandSpec{
			listCmd(), getCmd(), updateCmd(), appendCmd(), clearCmd(), formatCmd(),
			resizeCmd(), batchCmd(), metadataCmd(), createCmd(), copyCmd(), exportCmd(),
		},
	}
}

// parseValues is Bun parseValues, called before getGSheetsClient: --values-json as a JSON array, else the
// words joined, split into rows on "," and cells on "|", each trimmed.
func parseValues(in plugins.CommandInput, fail plugins.FailFunc) ([]any, error) {
	if raw := in.Option("values-json"); raw != "" {
		parsed, err := jsvalue.Parse([]byte(raw))
		if err != nil {
			return nil, fail("INVALID_PARAMS", "Invalid JSON values: "+jsvalue.ParseErrorMessage([]byte(raw)), "")
		}
		rows, ok := parsed.([]any)
		if !ok {
			return nil, fail("INVALID_PARAMS", "Invalid JSON values: JSON must be a 2D array", "")
		}
		return rows, nil
	}
	words, _ := in.Args["values"].([]string)
	if len(words) == 0 {
		return nil, fail("INVALID_PARAMS", "No values provided", "Provide values as args or via --values-json")
	}
	rows := []any{}
	for _, row := range strings.Split(strings.Join(words, " "), ",") {
		cells := []any{}
		for _, cell := range strings.Split(jsvalue.Trim(row), "|") {
			cells = append(cells, jsvalue.Trim(cell))
		}
		rows = append(rows, cells)
	}
	return rows, nil
}

// choice is Bun parseAlign / parseValign / parseWrap / parseBorder: an empty
// value is absent, anything else must be one of the lowercased keys.
func choice(value, name string, choices map[string]string, suggestion string, fail plugins.FailFunc) (string, error) {
	if value == "" {
		return "", nil
	}
	if v, ok := choices[strings.ToLower(value)]; ok {
		return v, nil
	}
	return "", fail("INVALID_PARAMS", "Invalid --"+name+" value: "+value, suggestion)
}

// parseRawFormat is Bun parseRawFormat: a JSON object, nil when absent.
func parseRawFormat(raw string, fail plugins.FailFunc) (*jsvalue.Object, error) {
	if raw == "" {
		return nil, nil
	}
	parsed, err := jsvalue.Parse([]byte(raw))
	if err != nil {
		return nil, fail("INVALID_PARAMS", "Invalid --raw JSON: "+jsvalue.ParseErrorMessage([]byte(raw)), "")
	}
	obj, ok := parsed.(*jsvalue.Object)
	if !ok || obj == nil {
		return nil, fail("INVALID_PARAMS", "--raw must be a JSON object (CellFormat)", "")
	}
	return obj, nil
}

var spreadsheetArg = plugins.ArgumentSpec{Name: "spreadsheet-id-or-url", Description: "Spreadsheet ID or URL", Required: true}

func rangeArg(description string) plugins.ArgumentSpec {
	return plugins.ArgumentSpec{Name: "range", Description: description, Required: true}
}

var valuesArg = plugins.ArgumentSpec{Name: "values", Description: "Values (comma-separated rows, pipe-separated cells)", Variadic: true}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List recent spreadsheets",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Number of spreadsheets", DefaultValue: "10"},
			{Flags: "--query <query>", Description: "Drive search query filter"},
		},
		Examples: []string{
			"# 10 most recently modified spreadsheets",
			"agentio gsheets list",
			"# spreadsheets you own",
			`agentio gsheets list --query "'me' in owners" --limit 50`,
			"# search by name fragment",
			`agentio gsheets list --query "name contains 'budget'"`,
			"# recently modified",
			`agentio gsheets list --query "modifiedTime > '2024-01-01'"`,
			"",
			"Query syntax: name contains '...', name = '...', 'me' in owners,",
			"modifiedTime > 'YYYY-MM-DD'. Combine with 'and'/'or'.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.list(jsvalue.ParseInt(in.Option("limit")), in.Option("query")))
		},
		Format: func(v any) string { return google.FormatDriveFiles(v, "Spreadsheets", "No spreadsheets found") },
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get values from a range",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg, rangeArg("Range in A1 notation (e.g., Sheet1!A1:B10)")},
		Options: []plugins.OptionSpec{
			{Flags: "--dimension <dim>", Description: "Major dimension: ROWS or COLUMNS"},
			{Flags: "--render <opt>", Description: "Value render: FORMATTED_VALUE, UNFORMATTED_VALUE, or FORMULA"},
		},
		Examples: []string{
			"# read a 2x3 block on Sheet1",
			`agentio gsheets get 1A2bCdEf... "Sheet1!A1:C2"`,
			"# entire column B",
			`agentio gsheets get 1A2bCdEf... "Sheet1!B:B"`,
			"# show formulas instead of computed values",
			`agentio gsheets get 1A2bCdEf... "Sheet1!A1:D10" --render FORMULA`,
			"# major dimension: COLUMNS (transposes orientation)",
			`agentio gsheets get 1A2bCdEf... "Sheet1!A1:C10" --dimension COLUMNS`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.get(in.Arg("spreadsheet-id-or-url"), in.Arg("range"), in.OptionPtr("dimension"), in.OptionPtr("render")))
		},
		Format: formatValues,
	}
}

func updateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "update",
		Description: "Update values in a range",
		Access:      "write",
		Prepare:     plugins.Parse(parseValues),
		Operation:   "update values",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg, rangeArg("Range in A1 notation (e.g., Sheet1!A1:B2)"), valuesArg},
		Options: []plugins.OptionSpec{
			{Flags: "--values-json <json>", Description: "Values as JSON 2D array"},
			{Flags: "--input <opt>", Description: "Value input option: RAW or USER_ENTERED", DefaultValue: "USER_ENTERED"},
		},
		Examples: []string{
			"# set a 2x2 block via simple format (',' = new row, '|' = new cell)",
			`agentio gsheets update 1A2bCdEf... "Sheet1!A1:B2" "a|b,c|d"`,
			"# same write via JSON",
			`agentio gsheets update 1A2bCdEf... "Sheet1!A1:B2" --values-json '[["a","b"],["c","d"]]'`,
			"# store raw text without formula parsing",
			`agentio gsheets update 1A2bCdEf... "Sheet1!A1" "=SUM(B:B)" --input RAW`,
			"# write a formula that gets evaluated",
			`agentio gsheets update 1A2bCdEf... "Sheet1!A1" "=SUM(B:B)" --input USER_ENTERED`,
			"",
			"Input options: RAW (stored as-is), USER_ENTERED (parsed like typed in UI).",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.update(in.Arg("spreadsheet-id-or-url"), in.Arg("range"), plugins.Prepared[[]any](run), in.Option("input")))
		},
		Format: formatUpdated,
	}
}

func appendCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "append",
		Description: "Append values to a range",
		Access:      "write",
		Prepare:     plugins.Parse(parseValues),
		Operation:   "append values",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg, rangeArg("Range in A1 notation (e.g., Sheet1!A:C)"), valuesArg},
		Options: []plugins.OptionSpec{
			{Flags: "--values-json <json>", Description: "Values as JSON 2D array"},
			{Flags: "--input <opt>", Description: "Value input option: RAW or USER_ENTERED", DefaultValue: "USER_ENTERED"},
			{Flags: "--insert <opt>", Description: "Insert data option: OVERWRITE or INSERT_ROWS"},
		},
		Examples: []string{
			"# append two rows to columns A-C",
			`agentio gsheets append 1A2bCdEf... "Sheet1!A:C" "alice|10|us,bob|7|fr"`,
			"# append via JSON",
			`agentio gsheets append 1A2bCdEf... "Sheet1!A:C" --values-json '[["a","b","c"],["d","e","f"]]'`,
			"# insert new rows instead of overwriting blanks below the table",
			`agentio gsheets append 1A2bCdEf... "Sheet1!A:C" "x|y|z" --insert INSERT_ROWS`,
			"",
			"Insert: OVERWRITE writes into existing cells, INSERT_ROWS shifts rows down.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.append(in.Arg("spreadsheet-id-or-url"), in.Arg("range"), plugins.Prepared[[]any](run), in.Option("input"), in.OptionPtr("insert")))
		},
		Format: formatAppended,
	}
}

func clearCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "clear",
		Description: "Clear values in a range",
		Access:      "write",
		Operation:   "clear values",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg, rangeArg("Range in A1 notation (e.g., Sheet1!A1:B10)")},
		Examples: []string{
			"# clear a small block",
			`agentio gsheets clear 1A2bCdEf... "Sheet1!A1:D10"`,
			"# clear an entire sheet",
			`agentio gsheets clear 1A2bCdEf... "Sheet1!A1:Z1000"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.clear(in.Arg("spreadsheet-id-or-url"), in.Arg("range")))
		},
		Format: formatCleared,
	}
}

func formatCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "format",
		Description: "Apply cell formatting (colors, text style, alignment, borders, merge)",
		Access:      "write",
		Operation:   "format range",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg, rangeArg("Range in A1 notation (e.g., Sheet1!A1:B10)")},
		Options: []plugins.OptionSpec{
			{Flags: "--bold", Description: "Make text bold"},
			{Flags: "--italic", Description: "Make text italic"},
			{Flags: "--underline", Description: "Underline text"},
			{Flags: "--font-size <n>", Description: "Font size in points"},
			{Flags: "--font-family <name>", Description: `Font family name (e.g., "Arial")`},
			{Flags: "--text-color <hex>", Description: "Text color as #rrggbb"},
			{Flags: "--background <hex>", Description: "Background color as #rrggbb"},
			{Flags: "--align <pos>", Description: "Horizontal alignment: left, center, right"},
			{Flags: "--valign <pos>", Description: "Vertical alignment: top, middle, bottom"},
			{Flags: "--wrap <strategy>", Description: "Text wrap: overflow, clip, wrap"},
			{Flags: "--number-format <pattern>", Description: `Number format pattern (e.g., "$#,##0.00", "0.00%")`},
			{Flags: "--border <style>", Description: "Borders: all, outer, none"},
			{Flags: "--merge", Description: "Merge the range into a single cell"},
			{Flags: "--clear-format", Description: "Clear existing formatting on the range first"},
			{Flags: "--raw <json>", Description: "Raw CellFormat JSON merged into the request"},
		},
		Examples: []string{
			"# bold header row with colored background and white text",
			`agentio gsheets format 1A2bCdEf... "Sheet1!A1:D1" --bold --background "#4285f4" --text-color "#ffffff"`,
			"# currency formatting on a column",
			`agentio gsheets format 1A2bCdEf... "Sheet1!C2:C100" --number-format "$#,##0.00"`,
			"# outer border around a table",
			`agentio gsheets format 1A2bCdEf... "Sheet1!A1:D10" --border outer`,
			"# merge title cells with centered bold text",
			`agentio gsheets format 1A2bCdEf... "Sheet1!A1:D1" --merge --align center --bold`,
			"# reset formatting on a range",
			`agentio gsheets format 1A2bCdEf... "Sheet1!A1:Z1000" --clear-format`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			o := formatOptions{
				bold:         in.Flag("bold"),
				italic:       in.Flag("italic"),
				underline:    in.Flag("underline"),
				fontSize:     in.IntOptionPtr("font-size"),
				fontFamily:   in.OptionPtr("font-family"),
				textColor:    in.OptionPtr("text-color"),
				background:   in.OptionPtr("background"),
				numberFormat: in.OptionPtr("number-format"),
				merge:        in.Flag("merge"),
				clearFormat:  in.Flag("clear-format"),
			}
			var err error
			if o.align, err = choice(in.Option("align"), "align", map[string]string{"left": "LEFT", "center": "CENTER", "centre": "CENTER", "right": "RIGHT"}, "Use left, center, or right", run.Fail); err != nil {
				return nil, err
			}
			if o.valign, err = choice(in.Option("valign"), "valign", map[string]string{"top": "TOP", "middle": "MIDDLE", "center": "MIDDLE", "bottom": "BOTTOM"}, "Use top, middle, or bottom", run.Fail); err != nil {
				return nil, err
			}
			if o.wrap, err = choice(in.Option("wrap"), "wrap", map[string]string{"overflow": "OVERFLOW_CELL", "clip": "CLIP", "wrap": "WRAP"}, "Use overflow, clip, or wrap", run.Fail); err != nil {
				return nil, err
			}
			if o.border, err = choice(in.Option("border"), "border", map[string]string{"all": "all", "outer": "outer", "none": "none"}, "Use all, outer, or none", run.Fail); err != nil {
				return nil, err
			}
			if o.raw, err = parseRawFormat(in.Option("raw"), run.Fail); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.format(in.Arg("spreadsheet-id-or-url"), in.Arg("range"), o))
		},
		Format: formatFormatted,
	}
}

func resizeCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "resize",
		Description: "Resize columns or rows (explicit pixel size or auto-fit)",
		Access:      "write",
		Operation:   "resize range",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg, rangeArg("Columns (Sheet1!A:C) or rows (Sheet1!1:10)")},
		Options: []plugins.OptionSpec{
			{Flags: "--size <pixels>", Description: "Pixel size"},
			{Flags: "--auto", Description: "Auto-fit to content"},
		},
		Examples: []string{
			"# set columns A-C to 200px wide",
			`agentio gsheets resize 1A2bCdEf... "Sheet1!A:C" --size 200`,
			"# auto-fit the header row to content",
			`agentio gsheets resize 1A2bCdEf... "Sheet1!1:1" --auto`,
			"# resize a single column",
			`agentio gsheets resize 1A2bCdEf... "Sheet1!B:B" --size 150`,
			"",
			"Range must be columns-only (A:C) or rows-only (1:10).",
			"--size and --auto are mutually exclusive.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.resize(in.Arg("spreadsheet-id-or-url"), in.Arg("range"), in.IntOptionPtr("size"), in.Flag("auto")))
		},
		Format: formatResized,
	}
}

func batchCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "batch",
		Description: "Execute raw spreadsheets.batchUpdate requests (escape hatch)",
		Access:      "write",
		Prepare:     plugins.Parse(google.BatchRequests),
		Operation:   "execute batch update",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg},
		Options: []plugins.OptionSpec{
			{Flags: "--requests-json <json>", Description: "Inline JSON array of batchUpdate requests"},
			{Flags: "--file <path>", Description: "Path to a JSON file containing the requests array"},
		},
		Examples: []string{
			"# freeze the first row (inline JSON)",
			`agentio gsheets batch 1A2bCdEf... --requests-json '[{"updateSheetProperties":{"properties":{"sheetId":0,"gridProperties":{"frozenRowCount":1}},"fields":"gridProperties.frozenRowCount"}}]'`,
			"# from a file",
			"agentio gsheets batch 1A2bCdEf... --file ./requests.json",
			"",
			"Accepts an array of Sheets API Request objects. See:",
			"https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.batch(in.Arg("spreadsheet-id-or-url"), plugins.Prepared[[]any](run)))
		},
		Format: formatBatch,
	}
}

func metadataCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "metadata",
		Description: "Get spreadsheet metadata",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg},
		Examples: []string{
			"# title, sheets, sheetIds, locale, etc.",
			"agentio gsheets metadata 1A2bCdEf...",
			"# accept a full URL",
			"agentio gsheets metadata https://docs.google.com/spreadsheets/d/1A2bCdEf.../edit",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.metadata(in.Arg("spreadsheet-id-or-url")))
		},
		Format: formatMetadata,
	}
}

func createCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "create",
		Description: "Create a new spreadsheet",
		Access:      "write",
		Operation:   "create spreadsheet",
		Arguments:   []plugins.ArgumentSpec{{Name: "title", Description: "Spreadsheet title", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--sheets <names>", Description: "Comma-separated sheet names to create"},
		},
		Examples: []string{
			"# blank spreadsheet with default Sheet1",
			`agentio gsheets create "Q4 Plan"`,
			"# multi-sheet workbook",
			`agentio gsheets create "Budget 2024" --sheets "Income,Expenses,Summary"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			var names []string
			if sheets := in.Option("sheets"); sheets != "" {
				for _, n := range strings.Split(sheets, ",") {
					names = append(names, jsvalue.Trim(n))
				}
			}
			return plugins.Result(a.create(in.Arg("title"), names))
		},
		Format: formatCreated,
	}
}

func copyCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "copy",
		Description: "Copy a spreadsheet",
		Access:      "write",
		Operation:   "copy spreadsheet",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg, {Name: "title", Description: "New spreadsheet title", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--parent <folder-id>", Description: "Destination folder ID"},
		},
		Examples: []string{
			"# duplicate to My Drive root",
			`agentio gsheets copy 1A2bCdEf... "Q4 Plan (copy)"`,
			"# duplicate into a specific folder",
			`agentio gsheets copy 1A2bCdEf... "Q4 Plan (copy)" --parent 1FoLdErIdAbCd...`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.CopyDriveFile(a.drive, extractSpreadsheetID(in.Arg("spreadsheet-id-or-url")), in.Arg("title"), in.Option("parent"), "copy spreadsheet", spreadsheetURL))
		},
		Format: formatCreated,
	}
}

// exportCmd has no Format: Bun prints three lines with console.log after
// writing the file, so the result is that text.
func exportCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "export",
		Description: "Export a spreadsheet to a file",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{spreadsheetArg},
		Options: []plugins.OptionSpec{
			{Flags: "--output <path>", Required: true, Description: "Output file path"},
			{Flags: "--format <fmt>", Description: "Export format: xlsx, pdf, csv, ods, tsv", DefaultValue: "xlsx"},
		},
		Examples: []string{
			"# default xlsx export",
			"agentio gsheets export 1A2bCdEf... --output report.xlsx",
			"# CSV (first sheet only)",
			"agentio gsheets export 1A2bCdEf... --output data.csv --format csv",
			"# PDF",
			"agentio gsheets export 1A2bCdEf... --output report.pdf --format pdf",
			"",
			"Formats: xlsx (default), pdf, csv, ods, tsv. csv and tsv are first sheet only.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			format := strings.ToLower(in.Option("format"))
			mimeType, ok := exportMimeTypes[format]
			if !ok {
				return nil, run.Fail("INVALID_PARAMS", "Unknown format: "+format, "Use xlsx, pdf, csv, ods, or tsv")
			}
			data, err := a.ExportDriveFile(a.drive, extractSpreadsheetID(in.Arg("spreadsheet-id-or-url")), mimeType, "export spreadsheet")
			if err != nil {
				return nil, err
			}
			output := in.Option("output")
			if err := nodefs.WriteFile(output, data); err != nil {
				return nil, err
			}
			return fmt.Sprintf("Exported to %s\n  Format: %s\n  Size: %d bytes", output, format, len(data)), nil
		},
	}
}
