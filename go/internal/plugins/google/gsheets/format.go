package gsheets

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// The printers read the Bun objects the client builds, as Bun's template
// strings do: a missing field prints "undefined".

// formatValues is printGSheetsValues: cells tab-separated, `String(cell ?? "")`.
// It stops at a null row, where Bun throws (valuesError).
func formatValues(v any) string {
	rows, _ := jsvalue.Member(v, "values").([]any)
	if len(rows) == 0 {
		return "No data found"
	}
	lines := []string{"Range: " + google.Field(v, "range"), ""}
	for _, row := range rows {
		cells, ok := row.([]any)
		if !ok {
			break
		}
		out := make([]string, len(cells))
		for i, cell := range cells {
			if !jsvalue.Nullish(cell) {
				out[i] = jsvalue.String(cell)
			}
		}
		lines = append(lines, strings.Join(out, "\t"))
	}
	return strings.Join(lines, "\n")
}

// countLines is the three lines both value writes print; head is
// "Updated N cells in" or "Appended N cells to".
func countLines(head string, v any) string {
	return fmt.Sprintf("%s %s\n  Rows: %s\n  Columns: %s", head, google.Field(v, "updatedRange"), google.Field(v, "updatedRows"), google.Field(v, "updatedColumns"))
}

// formatUpdated is printGSheetsUpdateResult.
func formatUpdated(v any) string {
	return countLines("Updated "+google.Field(v, "updatedCells")+" cells in", v)
}

// formatAppended is printGSheetsAppendResult.
func formatAppended(v any) string {
	return countLines("Appended "+google.Field(v, "updatedCells")+" cells to", v)
}

// formatCleared is printGSheetsClearResult.
func formatCleared(v any) string {
	return "Cleared " + google.Field(v, "clearedRange")
}

// formatMetadata is printGSheetsMetadata.
func formatMetadata(v any) string {
	lines := []string{"ID: " + google.Field(v, "id"), "Title: " + google.Field(v, "title")}
	if google.Truthy(v, "locale") {
		lines = append(lines, "Locale: "+google.Field(v, "locale"))
	}
	if google.Truthy(v, "timeZone") {
		lines = append(lines, "TimeZone: "+google.Field(v, "timeZone"))
	}
	lines = append(lines, "URL: "+google.Field(v, "url"), "", "Sheets:")
	sheets, _ := jsvalue.Member(v, "sheets").([]any)
	for _, sh := range sheets {
		lines = append(lines, fmt.Sprintf("  [%s] %s (%s rows x %s cols)", google.Field(sh, "id"), google.Field(sh, "title"), google.Field(sh, "rowCount"), google.Field(sh, "columnCount")))
	}
	return strings.Join(lines, "\n")
}

// formatCreated is printGSheetsCreated (create and copy).
func formatCreated(v any) string { return google.FormatCreatedFile(v, "Spreadsheet created") }

// formatFormatted is printGSheetsFormatResult.
func formatFormatted(v any) string {
	f, _ := v.(*formatted)
	if f == nil {
		return ""
	}
	lines := []string{"Formatted " + f.Range, "  Sheet: " + jsvalue.String(f.SheetTitle)}
	if f.Cleared {
		lines = append(lines, "  Cleared existing formatting")
	}
	if len(f.AppliedFields) > 0 {
		lines = append(lines, "  Applied: "+strings.Join(f.AppliedFields, ", "))
	}
	if f.Merged {
		lines = append(lines, "  Merged: yes")
	}
	return strings.Join(lines, "\n")
}

// formatResized is printGSheetsResizeResult.
func formatResized(v any) string {
	r, _ := v.(*resized)
	if r == nil {
		return ""
	}
	unit := "row(s)"
	if r.Dimension == "COLUMNS" {
		unit = "column(s)"
	}
	how := "auto-fit"
	if !r.Auto {
		size := "undefined"
		if r.PixelSize != nil {
			size = jsvalue.NumberString(float64(*r.PixelSize))
		}
		how = size + "px"
	}
	return fmt.Sprintf("Resized %d %s in %s\n  Sheet: %s\n  Size: %s", r.Count, unit, r.Range, jsvalue.String(r.SheetTitle), how)
}

// formatBatch is printGSheetsBatchResult.
func formatBatch(v any) string {
	return "Batch update applied to " + google.Field(v, "spreadsheetId") + "\n  Replies: " + google.Field(v, "replies")
}
