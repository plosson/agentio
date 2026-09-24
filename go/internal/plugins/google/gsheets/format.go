package gsheets

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// formatValues is printGSheetsValues: cells tab-separated, `String(cell ?? ”)`.
func formatValues(v any) string {
	r, _ := v.(*values)
	if r == nil || len(r.Values) == 0 {
		return "No data found"
	}
	lines := []string{"Range: " + r.Range, ""}
	for _, row := range r.Values {
		cells := make([]string, len(row))
		for i, cell := range row {
			if cell != nil {
				cells[i] = jsvalue.String(cell)
			}
		}
		lines = append(lines, strings.Join(cells, "\t"))
	}
	return strings.Join(lines, "\n")
}

// countLines is the three lines both value writes print; head is
// "Updated N cells in" or "Appended N cells to".
func countLines(head string, u updated) string {
	return fmt.Sprintf("%s %s\n  Rows: %s\n  Columns: %s", head, u.UpdatedRange, num(u.UpdatedRows), num(u.UpdatedColumns))
}

func num(n number) string { return jsvalue.NumberString(float64(n)) }

// formatUpdated is printGSheetsUpdateResult.
func formatUpdated(v any) string {
	u, _ := v.(*updated)
	if u == nil {
		return ""
	}
	return countLines("Updated "+num(u.UpdatedCells)+" cells in", *u)
}

// formatAppended is printGSheetsAppendResult.
func formatAppended(v any) string {
	u, _ := v.(*appended)
	if u == nil {
		return ""
	}
	return countLines("Appended "+num(u.UpdatedCells)+" cells to", updated(*u))
}

// formatCleared is printGSheetsClearResult.
func formatCleared(v any) string {
	c, _ := v.(*cleared)
	if c == nil {
		return ""
	}
	return "Cleared " + c.ClearedRange
}

// formatMetadata is printGSheetsMetadata.
func formatMetadata(v any) string {
	s, _ := v.(*spreadsheet)
	if s == nil {
		return ""
	}
	lines := []string{"ID: " + s.ID, "Title: " + s.Title}
	if s.Locale != "" {
		lines = append(lines, "Locale: "+s.Locale)
	}
	if s.TimeZone != "" {
		lines = append(lines, "TimeZone: "+s.TimeZone)
	}
	lines = append(lines, "URL: "+s.URL, "", "Sheets:")
	for _, sh := range s.Sheets {
		lines = append(lines, fmt.Sprintf("  [%d] %s (%d rows x %d cols)", sh.ID, sh.Title, sh.RowCount, sh.ColumnCount))
	}
	return strings.Join(lines, "\n")
}

// formatCreated is printGSheetsCreated (create and copy).
func formatCreated(v any) string {
	c, _ := v.(*created)
	if c == nil {
		return ""
	}
	return strings.Join([]string{"Spreadsheet created", "ID: " + c.ID, "Title: " + c.Title, "URL: " + c.URL}, "\n")
}

// formatFormatted is printGSheetsFormatResult.
func formatFormatted(v any) string {
	f, _ := v.(*formatted)
	if f == nil {
		return ""
	}
	lines := []string{"Formatted " + f.Range, "  Sheet: " + f.SheetTitle}
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
			size = num(*r.PixelSize)
		}
		how = size + "px"
	}
	return fmt.Sprintf("Resized %d %s in %s\n  Sheet: %s\n  Size: %s", r.Count, unit, r.Range, r.SheetTitle, how)
}

// formatBatch is printGSheetsBatchResult.
func formatBatch(v any) string {
	b, _ := v.(*batched)
	if b == nil {
		return ""
	}
	return fmt.Sprintf("Batch update applied to %s\n  Replies: %d", b.SpreadsheetID, b.Replies)
}
