package gsheets

import (
	"context"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	drive "google.golang.org/api/drive/v3"
	sheets "google.golang.org/api/sheets/v4"
)

const (
	sheetMimeType  = "application/vnd.google-apps.spreadsheet"
	spreadsheetURL = "https://docs.google.com/spreadsheets/d/"
)

// exportMimeTypes is GSheetsClient.export's formatMap.
var exportMimeTypes = map[string]string{
	"xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"pdf":  "application/pdf",
	"csv":  "text/csv",
	"ods":  "application/vnd.oasis.opendocument.spreadsheet",
	"tsv":  "text/tab-separated-values",
}

// number is a JavaScript number in a printed result: NaN is null, as
// JSON.stringify writes it.
type number float64

func (n number) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(float64(n)), nil }

// The results built from an answer are the Bun client's objects
// (GSheetsGetResult, GSheetsUpdateResult, GSheetsSpreadsheet, ...), read from
// the answer as JavaScript reads it (google.Answer): a value the answer lacks
// is undefined, a mistyped one prints as it came, and reading a field of a
// null answer or item fails with Bun's TypeError.

// formatted is GSheetsFormatResult. SheetTitle is the answer's
// `properties.title || ""`.
type formatted struct {
	Range         string   `json:"range"`
	SheetTitle    any      `json:"sheetTitle"`
	AppliedFields []string `json:"appliedFields"`
	Merged        bool     `json:"merged"`
	Cleared       bool     `json:"cleared"`
}

// resized is GSheetsResizeResult: PixelSize is absent for --auto.
type resized struct {
	Range      string  `json:"range"`
	SheetTitle any     `json:"sheetTitle"`
	Dimension  string  `json:"dimension"`
	Count      int     `json:"count"`
	PixelSize  *number `json:"pixelSize,omitempty"`
	Auto       bool    `json:"auto"`
}

// formatOptions is GSheetsFormatOptions after the command parsed its flags:
// a nil pointer is an absent option, as is an empty align, valign, wrap or
// border (Bun parses those with `if (!value)`).
type formatOptions struct {
	bold, italic, underline bool
	fontSize                *float64
	fontFamily              *string
	textColor, background   *string
	align, valign, wrap     string
	numberFormat            *string
	border                  string
	merge, clearFormat      bool
	raw                     *jsvalue.Object
}

// api is GSheetsClient. Reads and simple writes go through the typed
// sheets/v4 and drive/v3 clients (google.Answer for the answer). Calls whose
// body carries the caller's JSON (values, CellFormat, batchUpdate requests)
// send it with CallJSON, as the typed structs would drop, reorder or reformat
// it (unknown keys, key order, 1.0 versus 1).
type api struct {
	google.API
	sheets *sheets.Service
	drive  *drive.Service
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	driveSvc, err := google.DriveService(ctx, run)
	if err != nil {
		return nil, err
	}
	sheetsSvc, err := google.NewService(ctx, run, google.Camel, sheets.NewService)
	if err != nil {
		return nil, err
	}
	return &api{API: google.API{Ctx: ctx, RunContext: run, ErrorMessage: errorMessage}, sheets: sheetsSvc, drive: driveSvc}, nil
}

// errorMessage is GSheetsClient.getErrorMessage.
var errorMessage = google.StatusText("Insufficient permissions to access this spreadsheet", "Spreadsheet not found")

// callJSON sends body verbatim to the Sheets API and returns the answer.
func (a *api) callJSON(method, path string, body any) (any, error) {
	return google.CallJSON(a.Ctx, a.RunContext, google.Camel, method, a.sheets.BasePath, path, jsvalue.Stringify(body))
}

var (
	spreadsheetURLPattern = regexp.MustCompile(`/spreadsheets/d/([a-zA-Z0-9_-]+)`)
	spreadsheetIDPattern  = regexp.MustCompile(`id=([a-zA-Z0-9_-]+)`)
)

// extractSpreadsheetID accepts an ID, a /spreadsheets/d/<id> URL or an id= URL.
func extractSpreadsheetID(idOrURL string) string {
	if m := spreadsheetURLPattern.FindStringSubmatch(idOrURL); m != nil {
		return m[1]
	}
	if m := spreadsheetIDPattern.FindStringSubmatch(idOrURL); m != nil {
		return m[1]
	}
	return idOrURL
}

// cleanRange undoes a shell's \! escape (bash history expansion).
func cleanRange(r string) string {
	return strings.ReplaceAll(r, `\!`, "!")
}

func valuesPath(spreadsheetID, a1 string) string {
	return "v4/spreadsheets/" + url.PathEscape(spreadsheetID) + "/values/" + url.PathEscape(a1)
}

func (a *api) list(limit float64, query string) ([]any, error) {
	files, err := google.ListDriveFiles(a.Ctx, a.drive, sheetMimeType, query, limit, spreadsheetURL)
	if err != nil {
		return nil, a.Failed("list spreadsheets", err)
	}
	return files, nil
}

// get sends the options as googleapis does: a nil one is left out, a given ""
// is sent empty. The result is `{ range: data.range || cleanedRange, values:
// data.values || [] }`.
func (a *api) get(idOrURL, a1 string, dimension, render *string) (*jsvalue.Object, error) {
	r := cleanRange(a1)
	call := a.sheets.Spreadsheets.Values.Get(extractSpreadsheetID(idOrURL), r)
	if dimension != nil {
		call.MajorDimension(*dimension)
	}
	if render != nil {
		call.ValueRenderOption(*render)
	}
	_, raw, err := google.Answer(a.Ctx, call)
	if err == nil {
		var rng any
		if rng, err = jsvalue.Path(raw, "response.data", "range"); err == nil {
			return jsvalue.ObjectOf("range", jsvalue.Or(rng, r), "values", jsvalue.Or(jsvalue.Member(raw, "values"), []any{})), nil
		}
	}
	return nil, a.Failed("get values", err)
}

// valuesError is the TypeError printGSheetsValues throws at the first row
// that is null or undefined, after printing the rows before it.
func valuesError(result *jsvalue.Object) error {
	rows, _ := jsvalue.Member(result, "values").([]any)
	for _, row := range rows {
		if jsvalue.Nullish(row) {
			return jsvalue.TypeError(row, "row.map")
		}
	}
	return nil
}

// counts is the update and append result read from data (the answer, or its
// updates): `data.updatedRange || range` and each `data.<count> || 0`.
func counts(data any, r string) *jsvalue.Object {
	get := func(k string) any { return jsvalue.Optional(data, k) }
	return jsvalue.ObjectOf(
		"updatedRange", jsvalue.Or(get("updatedRange"), r),
		"updatedRows", jsvalue.Or(get("updatedRows"), 0),
		"updatedColumns", jsvalue.Or(get("updatedColumns"), 0),
		"updatedCells", jsvalue.Or(get("updatedCells"), 0),
	)
}

func valuesBody(rows []any) *jsvalue.Object {
	body := jsvalue.NewObject()
	body.Set("values", rows)
	return body
}

func (a *api) update(idOrURL, a1 string, rows []any, inputOption string) (*jsvalue.Object, error) {
	r := cleanRange(a1)
	if inputOption == "" {
		inputOption = "USER_ENTERED"
	}
	q := jsvalue.NewSearchParams()
	q.Set("valueInputOption", inputOption)
	raw, err := a.callJSON("PUT", valuesPath(extractSpreadsheetID(idOrURL), r)+"?"+q.String(), valuesBody(rows))
	if err == nil && jsvalue.Nullish(raw) {
		err = jsvalue.TypeError(raw, "response.data.updatedRange")
	}
	if err != nil {
		return nil, a.Failed("update values", err)
	}
	return counts(raw, r), nil
}

func (a *api) append(idOrURL, a1 string, rows []any, inputOption string, insertOption *string) (*jsvalue.Object, error) {
	r := cleanRange(a1)
	if inputOption == "" {
		inputOption = "USER_ENTERED"
	}
	q := jsvalue.NewSearchParams()
	q.Set("valueInputOption", inputOption)
	if insertOption != nil { // googleapis sends a given "" empty
		q.Set("insertDataOption", *insertOption)
	}
	raw, err := a.callJSON("POST", valuesPath(extractSpreadsheetID(idOrURL), r)+":append?"+q.String(), valuesBody(rows))
	var updates any
	if err == nil {
		updates, err = jsvalue.Path(raw, appendResponseText+".data", "updates")
	}
	if err != nil {
		return nil, a.Failed("append values", err)
	}
	return counts(updates, r), nil
}

// Bun's transpiler inlines a `response` read once, so JavaScriptCore names
// the call expression itself when its data is null (append's `updates`,
// clear's `clearedRange`, batch's `replies`, the sheet lookup's `sheets`).
const (
	appendResponseText = `(await this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range: cleanedRange,
        valueInputOption,
        insertDataOption: options.insertDataOption,
        requestBody: {
          values
        }
      }))`
	clearResponseText = `(await this.sheets.spreadsheets.values.clear({
          spreadsheetId,
          range: cleanedRange
        }))`
	batchResponseText = `(await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests }
        }))`
	getResponseText = `(await this.sheets.spreadsheets.get({ spreadsheetId }))`
)

func (a *api) clear(idOrURL, a1 string) (*jsvalue.Object, error) {
	r := cleanRange(a1)
	_, raw, err := google.Answer(a.Ctx, a.sheets.Spreadsheets.Values.Clear(extractSpreadsheetID(idOrURL), r, &sheets.ClearValuesRequest{}))
	var rng any
	if err == nil {
		rng, err = jsvalue.Path(raw, clearResponseText+".data", "clearedRange")
	}
	if err != nil {
		return nil, a.Failed("clear values", err)
	}
	return jsvalue.ObjectOf("clearedRange", jsvalue.Or(rng, r)), nil
}

// metadata is GSheetsClient.metadata over spreadsheets.get.
func (a *api) metadata(idOrURL string) (*jsvalue.Object, error) {
	id := extractSpreadsheetID(idOrURL)
	_, raw, err := google.Answer(a.Ctx, a.sheets.Spreadsheets.Get(id))
	var out *jsvalue.Object
	if err == nil {
		out, err = spreadsheetOf(raw, id)
	}
	if err != nil {
		return nil, a.Failed("get metadata", err)
	}
	return out, nil
}

// spreadsheetOf is the GSheetsSpreadsheet metadata builds from data.
func spreadsheetOf(data any, id string) (*jsvalue.Object, error) {
	props, err := jsvalue.Path(data, "response.data", "properties")
	if err != nil {
		return nil, err
	}
	items, err := jsvalue.Items(jsvalue.Or(jsvalue.Member(data, "sheets"), []any{}), "(response.data.sheets || [])")
	if err != nil {
		return nil, err
	}
	list := []any{}
	for _, s := range items {
		if jsvalue.Nullish(s) {
			return nil, jsvalue.TypeError(s, "sheet.properties")
		}
		p := jsvalue.Member(s, "properties")
		grid := jsvalue.Optional(p, "gridProperties")
		list = append(list, jsvalue.ObjectOf(
			"id", jsvalue.Or(jsvalue.Optional(p, "sheetId"), 0),
			"title", jsvalue.Or(jsvalue.Optional(p, "title"), "Untitled"),
			"rowCount", jsvalue.Or(jsvalue.Optional(grid, "rowCount"), 0),
			"columnCount", jsvalue.Or(jsvalue.Optional(grid, "columnCount"), 0),
		))
	}
	title, err := jsvalue.Path(props, "props", "title")
	if err != nil {
		return nil, err
	}
	return jsvalue.ObjectOf(
		"id", jsvalue.Member(data, "spreadsheetId"),
		"title", jsvalue.Or(title, "Untitled"),
		"locale", jsvalue.Or(jsvalue.Member(props, "locale"), jsvalue.Undefined),
		"timeZone", jsvalue.Or(jsvalue.Member(props, "timeZone"), jsvalue.Undefined),
		"url", jsvalue.Or(jsvalue.Member(data, "spreadsheetUrl"), spreadsheetURL+id),
		"sheets", list,
	), nil
}

// create is GSheetsClient.create: `{ id: data.spreadsheetId, title:
// data.properties?.title || title, url: data.spreadsheetUrl || <link> }`.
func (a *api) create(title string, sheetNames []string) (*jsvalue.Object, error) {
	// Titles go as given, "" included, as Bun sends them.
	body := &sheets.Spreadsheet{Properties: &sheets.SpreadsheetProperties{Title: title, ForceSendFields: []string{"Title"}}}
	for _, name := range sheetNames {
		body.Sheets = append(body.Sheets, &sheets.Sheet{Properties: &sheets.SheetProperties{Title: jsvalue.Trim(name), ForceSendFields: []string{"Title"}}})
	}
	_, raw, err := google.Answer(a.Ctx, a.sheets.Spreadsheets.Create(body))
	var id any
	if err == nil {
		id, err = jsvalue.Path(raw, "response.data", "spreadsheetId")
	}
	if err != nil {
		return nil, a.Failed("create spreadsheet", err)
	}
	return jsvalue.ObjectOf(
		"id", id,
		"title", jsvalue.Or(jsvalue.Optional(jsvalue.Member(raw, "properties"), "title"), title),
		"url", jsvalue.Or(jsvalue.Member(raw, "spreadsheetUrl"), spreadsheetURL+jsvalue.String(id)),
	), nil
}

// batchUpdate is spreadsheets.batchUpdate with requests sent as given.
func (a *api) batchUpdate(spreadsheetID string, requests []any) (any, error) {
	body := jsvalue.NewObject()
	body.Set("requests", requests)
	return a.callJSON("POST", "v4/spreadsheets/"+url.PathEscape(spreadsheetID)+":batchUpdate", body)
}

// batch is GSheetsClient.batch: `{ replies: response.data.replies?.length ??
// 0, spreadsheetId }` (GSheetsBatchResult).
func (a *api) batch(idOrURL string, requests []any) (*jsvalue.Object, error) {
	id := extractSpreadsheetID(idOrURL)
	if len(requests) == 0 {
		return nil, a.Fail("INVALID_PARAMS", "requests must be a non-empty array", "")
	}
	raw, err := a.batchUpdate(id, requests)
	var replies any
	if err == nil {
		replies, err = jsvalue.Path(raw, batchResponseText+".data", "replies")
	}
	if err != nil {
		return nil, a.Failed("execute batch update", err)
	}
	count := jsvalue.Optional(replies, "length")
	if jsvalue.Nullish(count) {
		count = 0
	}
	return jsvalue.ObjectOf("replies", count, "spreadsheetId", id), nil
}

// targetSheet is the resolveGridRange / resolveDimensionRange lookup: the
// named sheet, or the first one when the range names none. It returns the
// sheet's `properties.sheetId ?? 0` and `properties.title || ""`. A failed
// call, or a null answer or sheet, is reported as operation, the command's.
func (a *api) targetSheet(spreadsheetID, title, operation string) (sheetID, sheetTitle any, err error) {
	_, raw, err := google.Answer(a.Ctx, a.sheets.Spreadsheets.Get(spreadsheetID))
	var props any
	if err == nil {
		props, err = findSheet(raw, title)
	}
	if err != nil {
		return nil, nil, a.Failed(operation, err)
	}
	if !jsvalue.Truthy(props) {
		name := title
		if name == "" {
			name = "(first sheet)"
		}
		return nil, nil, a.Fail("NOT_FOUND", "Sheet not found: "+name, "")
	}
	sheetID = jsvalue.Member(props, "sheetId")
	if jsvalue.Nullish(sheetID) {
		sheetID = 0
	}
	return sheetID, jsvalue.Or(jsvalue.Member(props, "title"), ""), nil
}

// findSheet is `targetSheet?.properties` for the sheet named title (the
// first sheet for ""), in the answer's `data.sheets || []`.
func findSheet(data any, title string) (any, error) {
	sheets, err := jsvalue.Path(data, getResponseText+".data", "sheets")
	if err != nil {
		return nil, err
	}
	sheets = jsvalue.Or(sheets, []any{})
	if title == "" {
		return jsvalue.Optional(jsvalue.Member(sheets, "0"), "properties"), nil
	}
	items, _ := sheets.([]any)
	for _, s := range items {
		if jsvalue.Nullish(s) {
			return nil, jsvalue.TypeError(s, "s.properties")
		}
		if jsvalue.StrictEqual(jsvalue.Optional(jsvalue.Member(s, "properties"), "title"), title) {
			return jsvalue.Member(s, "properties"), nil
		}
	}
	return jsvalue.Undefined, nil
}

func (a *api) format(idOrURL, a1 string, o formatOptions) (*formatted, error) {
	id := extractSpreadsheetID(idOrURL)
	r := cleanRange(a1)
	title, cells := parseA1Range(r)
	sheetID, sheetTitle, err := a.targetSheet(id, title, "format range")
	if err != nil {
		return nil, err
	}
	bounds, err := parseCellRange(cells, a.Fail)
	if err != nil {
		return nil, err
	}
	grid := gridRange(sheetID, bounds)
	var requests []any
	applied := []string{}

	if o.clearFormat {
		requests = append(requests, obj("repeatCell", obj("range", grid, "cell", jsvalue.NewObject(), "fields", "userEnteredFormat")))
	}

	cellFormat := jsvalue.NewObject()
	var mask []string
	if o.background != nil {
		c, err := parseHexColor(*o.background, a.Fail)
		if err != nil {
			return nil, err
		}
		cellFormat.Set("backgroundColor", c)
		mask = append(mask, "backgroundColor")
	}
	for _, f := range []struct{ key, value string }{
		{"horizontalAlignment", o.align}, {"verticalAlignment", o.valign}, {"wrapStrategy", o.wrap},
	} {
		if f.value != "" {
			cellFormat.Set(f.key, f.value)
			mask = append(mask, f.key)
		}
	}
	if o.numberFormat != nil {
		cellFormat.Set("numberFormat", obj("type", "NUMBER", "pattern", *o.numberFormat))
		mask = append(mask, "numberFormat")
	}

	textFormat := jsvalue.NewObject()
	var textMask []string
	for _, f := range []struct {
		key string
		on  bool
	}{{"bold", o.bold}, {"italic", o.italic}, {"underline", o.underline}} {
		if f.on {
			textFormat.Set(f.key, true)
			textMask = append(textMask, f.key)
		}
	}
	if o.fontSize != nil {
		textFormat.Set("fontSize", *o.fontSize)
		textMask = append(textMask, "fontSize")
	}
	if o.fontFamily != nil {
		textFormat.Set("fontFamily", *o.fontFamily)
		textMask = append(textMask, "fontFamily")
	}
	if o.textColor != nil {
		c, err := parseHexColor(*o.textColor, a.Fail)
		if err != nil {
			return nil, err
		}
		textFormat.Set("foregroundColor", c)
		textMask = append(textMask, "foregroundColor")
	}
	if len(textMask) > 0 {
		cellFormat.Set("textFormat", textFormat)
		for _, part := range textMask {
			mask = append(mask, "textFormat."+part)
		}
	}

	if o.raw != nil {
		for _, key := range o.raw.Keys() {
			v, _ := o.raw.Get(key)
			cellFormat.Set(key, v)
		}
		for _, key := range o.raw.Keys() {
			covered := false
			for _, p := range mask {
				if p == key || strings.HasPrefix(p, key+".") {
					covered = true
					break
				}
			}
			if !covered {
				mask = append(mask, key)
			}
		}
	}

	if len(mask) > 0 {
		fields := make([]string, len(mask))
		for i, p := range mask {
			fields[i] = "userEnteredFormat." + p
		}
		requests = append(requests, obj("repeatCell", obj("range", grid, "cell", obj("userEnteredFormat", cellFormat), "fields", strings.Join(fields, ","))))
		applied = append(applied, mask...)
	}
	if o.border != "" {
		requests = append(requests, borderRequest(grid, o.border))
		applied = append(applied, "border:"+o.border)
	}
	if o.merge {
		requests = append(requests, obj("mergeCells", obj("range", grid, "mergeType", "MERGE_ALL")))
	}
	if len(requests) == 0 {
		return nil, a.Fail("INVALID_PARAMS", "No formatting options specified", "Pass at least one format flag or --clear-format")
	}
	if _, err := a.batchUpdate(id, requests); err != nil {
		return nil, a.Failed("format range", err)
	}
	return &formatted{Range: r, SheetTitle: sheetTitle, AppliedFields: applied, Merged: o.merge, Cleared: o.clearFormat}, nil
}

func (a *api) resize(idOrURL, a1 string, pixelSize *float64, auto bool) (*resized, error) {
	id := extractSpreadsheetID(idOrURL)
	r := cleanRange(a1)
	if !auto && pixelSize == nil {
		return nil, a.Fail("INVALID_PARAMS", "Specify --size <pixels> or --auto", "")
	}
	if auto && pixelSize != nil {
		return nil, a.Fail("INVALID_PARAMS", "--size and --auto are mutually exclusive", "")
	}
	title, cells := parseA1Range(r)
	if cells == "" {
		return nil, a.Fail("INVALID_PARAMS", "Resize range must reference columns or rows (e.g. Sheet1!A:C or Sheet1!1:10)", "")
	}
	sheetID, sheetTitle, err := a.targetSheet(id, title, "resize dimension")
	if err != nil {
		return nil, err
	}
	b, err := parseCellRange(cells, a.Fail)
	if err != nil {
		return nil, err
	}
	hasCols, hasRows := b.startCol != nil, b.startRow != nil
	if hasCols && hasRows {
		return nil, a.Fail("INVALID_PARAMS", "Resize range must be columns-only (A:C) or rows-only (1:10), got "+cells, "")
	}
	if !hasCols && !hasRows {
		return nil, a.Fail("INVALID_PARAMS", "Could not parse resize range: "+cells, "")
	}
	dimension, start, end := "COLUMNS", b.startCol, b.endCol
	if !hasCols {
		dimension, start, end = "ROWS", b.startRow, b.endRow
	}
	dimRange := obj("sheetId", sheetID, "dimension", dimension)
	setIndex(dimRange, "startIndex", start)
	setIndex(dimRange, "endIndex", end)
	var request *jsvalue.Object
	if auto {
		request = obj("autoResizeDimensions", obj("dimensions", dimRange))
	} else {
		request = obj("updateDimensionProperties", obj("range", dimRange, "properties", obj("pixelSize", *pixelSize), "fields", "pixelSize"))
	}
	if _, err := a.batchUpdate(id, []any{request}); err != nil {
		return nil, a.Failed("resize dimension", err)
	}
	out := &resized{Range: r, SheetTitle: sheetTitle, Dimension: dimension, Count: deref(end) - deref(start), Auto: auto}
	if pixelSize != nil {
		n := number(*pixelSize)
		out.PixelSize = &n
	}
	return out, nil
}

// obj is an object literal: key, value pairs in order.
func obj(pairs ...any) *jsvalue.Object {
	o := jsvalue.NewObject()
	for i := 0; i+1 < len(pairs); i += 2 {
		o.Set(pairs[i].(string), pairs[i+1])
	}
	return o
}

// setIndex sets key unless the index is undefined (JSON.stringify drops it).
func setIndex(o *jsvalue.Object, key string, index *int) {
	if index != nil {
		o.Set(key, *index)
	}
}

// deref is `index ?? 0`.
func deref(index *int) int {
	if index == nil {
		return 0
	}
	return *index
}

var hexColorPattern = regexp.MustCompile(`^[0-9a-fA-F]{6}$`)

// parseHexColor is Bun parseHexColor: #rrggbb as 0-1 channel fractions.
func parseHexColor(hex string, fail plugins.FailFunc) (*jsvalue.Object, error) {
	cleaned := strings.TrimPrefix(jsvalue.Trim(hex), "#")
	if !hexColorPattern.MatchString(cleaned) {
		return nil, fail("INVALID_PARAMS", "Invalid hex color: "+hex, "Use format #rrggbb (e.g., #ff0000)")
	}
	channel := func(i int) float64 {
		n, _ := strconv.ParseUint(cleaned[i:i+2], 16, 8)
		return float64(n) / 255
	}
	return obj("red", channel(0), "green", channel(2), "blue", channel(4)), nil
}

// borderRequest is Bun buildBorderRequest: "all" adds the inner lines.
func borderRequest(grid *jsvalue.Object, style string) *jsvalue.Object {
	lineStyle := "SOLID"
	if style == "none" {
		lineStyle = "NONE"
	}
	border := obj("style", lineStyle)
	req := obj("range", grid, "top", border, "bottom", border, "left", border, "right", border)
	if style == "all" {
		req.Set("innerHorizontal", border)
		req.Set("innerVertical", border)
	}
	return obj("updateBorders", req)
}

var (
	a1CellsPattern = regexp.MustCompile(`(?i)^[A-Z]+\d*(:[A-Z]+\d*)?$`)
	a1RowsPattern  = regexp.MustCompile(`^\d+:\d+$`)
	cellRefPattern = regexp.MustCompile(`(?i)^([A-Z]+)?(\d+)?$`)
)

// parseA1Range is Bun parseA1Range: the sheet title (quotes removed) and the
// cell part; a bare range without "!" is cells when it looks like A1 or 1:10,
// else a sheet title. Empty is undefined.
func parseA1Range(r string) (title, cells string) {
	bang := strings.Index(r, "!")
	if bang == -1 {
		if a1CellsPattern.MatchString(r) || a1RowsPattern.MatchString(r) {
			return "", r
		}
		return r, ""
	}
	title = r[:bang]
	if strings.HasPrefix(title, "'") && strings.HasSuffix(title, "'") {
		// "'".slice(1, -1) is "".
		if len(title) >= 2 {
			title = title[1 : len(title)-1]
		} else {
			title = ""
		}
		title = strings.ReplaceAll(title, "''", "'")
	}
	return title, r[bang+1:]
}

// bounds is Bun parseCellRange's result: zero-based, end exclusive, nil when
// the reference leaves that side open.
type bounds struct {
	startRow, endRow, startCol, endCol *int
}

// parseCellRange is Bun parseCellRange.
func parseCellRange(cells string, fail plugins.FailFunc) (bounds, error) {
	if cells == "" {
		return bounds{}, nil
	}
	refs := strings.Split(cells, ":")
	parseRef := func(ref string) (col, row *int, err error) {
		m := cellRefPattern.FindStringSubmatch(ref)
		if m == nil || (m[1] == "" && m[2] == "") {
			return nil, nil, fail("INVALID_PARAMS", "Invalid cell reference: "+ref, "Use A1 notation like A1, B2, or A:B")
		}
		if m[1] != "" {
			c := colLettersToIndex(m[1])
			col = &c
		}
		if m[2] != "" {
			r := int(jsvalue.ParseInt(m[2])) - 1
			row = &r
		}
		return col, row, nil
	}
	sCol, sRow, err := parseRef(refs[0])
	if err != nil {
		return bounds{}, err
	}
	eCol, eRow := sCol, sRow
	if len(refs) > 1 && refs[1] != "" {
		if eCol, eRow, err = parseRef(refs[1]); err != nil {
			return bounds{}, err
		}
	}
	return bounds{startRow: sRow, endRow: plusOne(eRow), startCol: sCol, endCol: plusOne(eCol)}, nil
}

func plusOne(i *int) *int {
	if i == nil {
		return nil
	}
	n := *i + 1
	return &n
}

func colLettersToIndex(letters string) int {
	index := 0
	for _, ch := range strings.ToUpper(letters) {
		index = index*26 + int(ch-64)
	}
	return index - 1
}

// gridRange is the GridRange Bun builds: sheetId, then each defined bound.
func gridRange(sheetID any, b bounds) *jsvalue.Object {
	g := obj("sheetId", sheetID)
	setIndex(g, "startRowIndex", b.startRow)
	setIndex(g, "endRowIndex", b.endRow)
	setIndex(g, "startColumnIndex", b.startCol)
	setIndex(g, "endColumnIndex", b.endCol)
	return g
}
