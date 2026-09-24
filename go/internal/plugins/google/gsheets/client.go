package gsheets

import (
	"context"
	"io"
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

const sheetMimeType = "application/vnd.google-apps.spreadsheet"

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

// values is GSheetsGetResult.
type values struct {
	Range  string  `json:"range"`
	Values [][]any `json:"values"`
}

// updated is GSheetsUpdateResult and GSheetsAppendResult.
type updated struct {
	UpdatedRange   string `json:"updatedRange"`
	UpdatedRows    number `json:"updatedRows"`
	UpdatedColumns number `json:"updatedColumns"`
	UpdatedCells   number `json:"updatedCells"`
}

// appended is the append result, printed as "Appended ...".
type appended updated

// cleared is GSheetsClearResult.
type cleared struct {
	ClearedRange string `json:"clearedRange"`
}

// sheet is GSheetsSheet.
type sheet struct {
	ID          int64  `json:"id"`
	Title       string `json:"title"`
	RowCount    int64  `json:"rowCount"`
	ColumnCount int64  `json:"columnCount"`
}

// spreadsheet is GSheetsSpreadsheet.
type spreadsheet struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Locale   string  `json:"locale,omitempty"`
	TimeZone string  `json:"timeZone,omitempty"`
	URL      string  `json:"url"`
	Sheets   []sheet `json:"sheets"`
}

// created is GSheetsCreateResult (create and copy).
type created struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

// formatted is GSheetsFormatResult.
type formatted struct {
	Range         string   `json:"range"`
	SheetTitle    string   `json:"sheetTitle"`
	AppliedFields []string `json:"appliedFields"`
	Merged        bool     `json:"merged"`
	Cleared       bool     `json:"cleared"`
}

// resized is GSheetsResizeResult: PixelSize is absent for --auto.
type resized struct {
	Range      string  `json:"range"`
	SheetTitle string  `json:"sheetTitle"`
	Dimension  string  `json:"dimension"`
	Count      int     `json:"count"`
	PixelSize  *number `json:"pixelSize,omitempty"`
	Auto       bool    `json:"auto"`
}

// batched is GSheetsBatchResult.
type batched struct {
	Replies       int    `json:"replies"`
	SpreadsheetID string `json:"spreadsheetId"`
}

// formatOptions is GSheetsFormatOptions after the command parsed its flags:
// an empty string or nil pointer is an absent option.
type formatOptions struct {
	bold, italic, underline bool
	fontSize                *float64
	fontFamily              string
	textColor, background   string
	align, valign, wrap     string
	numberFormat            string
	border                  string
	merge, clearFormat      bool
	raw                     *jsvalue.Object
}

// api is GSheetsClient. Reads and simple writes go through the typed
// sheets/v4 and drive/v3 clients. Calls whose body carries the caller's JSON
// (values, CellFormat, batchUpdate requests) send ordered JSON at the sheets
// client's BasePath, as the typed structs would drop or reorder it.
type api struct {
	ctx    context.Context
	run    *plugins.RunContext
	sheets *sheets.Service
	drive  *drive.Service
	fail   func(code plugins.ErrorCode, message, suggestion string) error
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
	return &api{ctx: ctx, run: run, sheets: sheetsSvc, drive: driveSvc, fail: run.Fail}, nil
}

// apiError is GSheetsClient.throwApiError.
func (a *api) apiError(operation string, err error) error {
	message := google.StatusMessage(err, "Insufficient permissions to access this spreadsheet", "Spreadsheet not found")
	return a.fail(google.ErrorCode(err), "Failed to "+operation+": "+message, "")
}

// callJSON sends body to the Sheets API and returns the reply object.
func (a *api) callJSON(method, path string, body any) (*jsvalue.Object, error) {
	v, err := google.CallJSON(a.ctx, a.run, google.Camel, method, a.sheets.BasePath, path, jsvalue.Stringify(body))
	if err != nil {
		return nil, err
	}
	obj, _ := v.(*jsvalue.Object)
	return obj, nil
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

func (a *api) list(limit float64, query string) ([]google.DriveFile, error) {
	files, err := google.ListDriveFiles(a.ctx, a.drive, sheetMimeType, query, limit, "https://docs.google.com/spreadsheets/d/")
	if err != nil {
		return nil, a.apiError("list spreadsheets", err)
	}
	return files, nil
}

func (a *api) get(idOrURL, a1, dimension, render string) (*values, error) {
	r := cleanRange(a1)
	call := a.sheets.Spreadsheets.Values.Get(extractSpreadsheetID(idOrURL), r)
	if dimension != "" {
		call.MajorDimension(dimension)
	}
	if render != "" {
		call.ValueRenderOption(render)
	}
	resp, err := call.Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("get values", err)
	}
	out := &values{Range: resp.Range, Values: resp.Values}
	if out.Range == "" {
		out.Range = r
	}
	if out.Values == nil {
		out.Values = [][]any{}
	}
	return out, nil
}

// counts reads `data.updatedRange || range` and each `data.<count> || 0`.
func counts(obj *jsvalue.Object, r string) updated {
	out := updated{UpdatedRange: r}
	if s, _ := obj.Str("updatedRange"); s != "" {
		out.UpdatedRange = s
	}
	count := func(key string) number {
		v, _ := obj.Get(key)
		if !jsvalue.Truthy(v) {
			return 0
		}
		return number(jsvalue.Number(jsvalue.String(v)))
	}
	out.UpdatedRows, out.UpdatedColumns, out.UpdatedCells = count("updatedRows"), count("updatedColumns"), count("updatedCells")
	return out
}

func valuesBody(rows []any) *jsvalue.Object {
	body := jsvalue.NewObject()
	body.Set("values", rows)
	return body
}

func (a *api) update(idOrURL, a1 string, rows []any, inputOption string) (*updated, error) {
	r := cleanRange(a1)
	if inputOption == "" {
		inputOption = "USER_ENTERED"
	}
	q := jsvalue.NewSearchParams()
	q.Set("valueInputOption", inputOption)
	obj, err := a.callJSON("PUT", valuesPath(extractSpreadsheetID(idOrURL), r)+"?"+q.String(), valuesBody(rows))
	if err != nil {
		return nil, a.apiError("update values", err)
	}
	out := counts(obj, r)
	return &out, nil
}

func (a *api) append(idOrURL, a1 string, rows []any, inputOption, insertOption string) (*appended, error) {
	r := cleanRange(a1)
	if inputOption == "" {
		inputOption = "USER_ENTERED"
	}
	q := jsvalue.NewSearchParams()
	q.Set("valueInputOption", inputOption)
	if insertOption != "" {
		q.Set("insertDataOption", insertOption)
	}
	obj, err := a.callJSON("POST", valuesPath(extractSpreadsheetID(idOrURL), r)+":append?"+q.String(), valuesBody(rows))
	if err != nil {
		return nil, a.apiError("append values", err)
	}
	updates, _ := obj.Get("updates")
	inner, _ := updates.(*jsvalue.Object)
	out := appended(counts(inner, r))
	return &out, nil
}

func (a *api) clear(idOrURL, a1 string) (*cleared, error) {
	r := cleanRange(a1)
	resp, err := a.sheets.Spreadsheets.Values.Clear(extractSpreadsheetID(idOrURL), r, &sheets.ClearValuesRequest{}).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("clear values", err)
	}
	out := &cleared{ClearedRange: resp.ClearedRange}
	if out.ClearedRange == "" {
		out.ClearedRange = r
	}
	return out, nil
}

func (a *api) metadata(idOrURL string) (*spreadsheet, error) {
	id := extractSpreadsheetID(idOrURL)
	resp, err := a.sheets.Spreadsheets.Get(id).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("get metadata", err)
	}
	props := resp.Properties
	if props == nil {
		props = &sheets.SpreadsheetProperties{}
	}
	out := &spreadsheet{ID: resp.SpreadsheetId, Title: props.Title, Locale: props.Locale, TimeZone: props.TimeZone, URL: resp.SpreadsheetUrl, Sheets: []sheet{}}
	if out.Title == "" {
		out.Title = "Untitled"
	}
	if out.URL == "" {
		out.URL = "https://docs.google.com/spreadsheets/d/" + id
	}
	for _, s := range resp.Sheets {
		item := sheet{Title: "Untitled"}
		if p := s.Properties; p != nil {
			item.ID = p.SheetId
			if p.Title != "" {
				item.Title = p.Title
			}
			if g := p.GridProperties; g != nil {
				item.RowCount, item.ColumnCount = g.RowCount, g.ColumnCount
			}
		}
		out.Sheets = append(out.Sheets, item)
	}
	return out, nil
}

func (a *api) create(title string, sheetNames []string) (*created, error) {
	body := &sheets.Spreadsheet{Properties: &sheets.SpreadsheetProperties{Title: title}}
	for _, name := range sheetNames {
		body.Sheets = append(body.Sheets, &sheets.Sheet{Properties: &sheets.SheetProperties{Title: jsvalue.Trim(name)}})
	}
	resp, err := a.sheets.Spreadsheets.Create(body).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("create spreadsheet", err)
	}
	out := &created{ID: resp.SpreadsheetId, Title: title, URL: resp.SpreadsheetUrl}
	if resp.Properties != nil && resp.Properties.Title != "" {
		out.Title = resp.Properties.Title
	}
	if out.URL == "" {
		out.URL = "https://docs.google.com/spreadsheets/d/" + resp.SpreadsheetId
	}
	return out, nil
}

func (a *api) copy(idOrURL, title, parentFolderID string) (*created, error) {
	file := &drive.File{Name: title}
	if parentFolderID != "" {
		file.Parents = []string{parentFolderID}
	}
	f, err := a.drive.Files.Copy(extractSpreadsheetID(idOrURL), file).Fields("id,name,webViewLink").Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("copy spreadsheet", err)
	}
	out := &created{ID: f.Id, Title: f.Name, URL: f.WebViewLink}
	if out.Title == "" {
		out.Title = title
	}
	if out.URL == "" {
		out.URL = "https://docs.google.com/spreadsheets/d/" + f.Id
	}
	return out, nil
}

// export is the Drive export bytes of the spreadsheet as mimeType.
func (a *api) export(idOrURL, mimeType string) ([]byte, error) {
	resp, err := a.drive.Files.Export(extractSpreadsheetID(idOrURL), mimeType).Context(a.ctx).Download()
	if err != nil {
		return nil, a.apiError("export spreadsheet", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, a.apiError("export spreadsheet", err)
	}
	return body, nil
}

// batchUpdate is spreadsheets.batchUpdate with requests sent as given.
func (a *api) batchUpdate(spreadsheetID string, requests []any) (*jsvalue.Object, error) {
	body := jsvalue.NewObject()
	body.Set("requests", requests)
	return a.callJSON("POST", "v4/spreadsheets/"+url.PathEscape(spreadsheetID)+":batchUpdate", body)
}

func (a *api) batch(idOrURL string, requests []any) (*batched, error) {
	id := extractSpreadsheetID(idOrURL)
	if len(requests) == 0 {
		return nil, a.fail("INVALID_PARAMS", "requests must be a non-empty array", "")
	}
	resp, err := a.batchUpdate(id, requests)
	if err != nil {
		return nil, a.apiError("execute batch update", err)
	}
	replies, _ := resp.Get("replies")
	items, _ := replies.([]any)
	return &batched{Replies: len(items), SpreadsheetID: id}, nil
}

// targetSheet is the resolveGridRange / resolveDimensionRange lookup: the
// named sheet, or the first one when the range names none. A failed call is
// reported as operation, the command's.
func (a *api) targetSheet(spreadsheetID, title, operation string) (*sheets.SheetProperties, error) {
	resp, err := a.sheets.Spreadsheets.Get(spreadsheetID).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError(operation, err)
	}
	var found *sheets.Sheet
	if title != "" {
		for _, s := range resp.Sheets {
			if s.Properties != nil && s.Properties.Title == title {
				found = s
				break
			}
		}
	} else if len(resp.Sheets) > 0 {
		found = resp.Sheets[0]
	}
	if found == nil || found.Properties == nil {
		name := title
		if name == "" {
			name = "(first sheet)"
		}
		return nil, a.fail("NOT_FOUND", "Sheet not found: "+name, "")
	}
	return found.Properties, nil
}

func (a *api) format(idOrURL, a1 string, o formatOptions) (*formatted, error) {
	id := extractSpreadsheetID(idOrURL)
	r := cleanRange(a1)
	title, cells := parseA1Range(r)
	props, err := a.targetSheet(id, title, "format range")
	if err != nil {
		return nil, err
	}
	bounds, err := parseCellRange(cells, a.fail)
	if err != nil {
		return nil, err
	}
	grid := gridRange(props.SheetId, bounds)
	var requests []any
	applied := []string{}

	if o.clearFormat {
		requests = append(requests, obj("repeatCell", obj("range", grid, "cell", jsvalue.NewObject(), "fields", "userEnteredFormat")))
	}

	cellFormat := jsvalue.NewObject()
	var mask []string
	if o.background != "" {
		c, err := parseHexColor(o.background, a.fail)
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
	if o.numberFormat != "" {
		cellFormat.Set("numberFormat", obj("type", "NUMBER", "pattern", o.numberFormat))
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
	if o.fontFamily != "" {
		textFormat.Set("fontFamily", o.fontFamily)
		textMask = append(textMask, "fontFamily")
	}
	if o.textColor != "" {
		c, err := parseHexColor(o.textColor, a.fail)
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
		return nil, a.fail("INVALID_PARAMS", "No formatting options specified", "Pass at least one format flag or --clear-format")
	}
	if _, err := a.batchUpdate(id, requests); err != nil {
		return nil, a.apiError("format range", err)
	}
	return &formatted{Range: r, SheetTitle: props.Title, AppliedFields: applied, Merged: o.merge, Cleared: o.clearFormat}, nil
}

func (a *api) resize(idOrURL, a1 string, pixelSize *float64, auto bool) (*resized, error) {
	id := extractSpreadsheetID(idOrURL)
	r := cleanRange(a1)
	if !auto && pixelSize == nil {
		return nil, a.fail("INVALID_PARAMS", "Specify --size <pixels> or --auto", "")
	}
	if auto && pixelSize != nil {
		return nil, a.fail("INVALID_PARAMS", "--size and --auto are mutually exclusive", "")
	}
	title, cells := parseA1Range(r)
	if cells == "" {
		return nil, a.fail("INVALID_PARAMS", "Resize range must reference columns or rows (e.g. Sheet1!A:C or Sheet1!1:10)", "")
	}
	props, err := a.targetSheet(id, title, "resize dimension")
	if err != nil {
		return nil, err
	}
	b, err := parseCellRange(cells, a.fail)
	if err != nil {
		return nil, err
	}
	hasCols, hasRows := b.startCol != nil, b.startRow != nil
	if hasCols && hasRows {
		return nil, a.fail("INVALID_PARAMS", "Resize range must be columns-only (A:C) or rows-only (1:10), got "+cells, "")
	}
	if !hasCols && !hasRows {
		return nil, a.fail("INVALID_PARAMS", "Could not parse resize range: "+cells, "")
	}
	dimension, start, end := "COLUMNS", b.startCol, b.endCol
	if !hasCols {
		dimension, start, end = "ROWS", b.startRow, b.endRow
	}
	dimRange := obj("sheetId", props.SheetId, "dimension", dimension)
	setIndex(dimRange, "startIndex", start)
	setIndex(dimRange, "endIndex", end)
	var request *jsvalue.Object
	if auto {
		request = obj("autoResizeDimensions", obj("dimensions", dimRange))
	} else {
		request = obj("updateDimensionProperties", obj("range", dimRange, "properties", obj("pixelSize", *pixelSize), "fields", "pixelSize"))
	}
	if _, err := a.batchUpdate(id, []any{request}); err != nil {
		return nil, a.apiError("resize dimension", err)
	}
	out := &resized{Range: r, SheetTitle: props.Title, Dimension: dimension, Count: deref(end) - deref(start), Auto: auto}
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
func parseHexColor(hex string, fail func(plugins.ErrorCode, string, string) error) (*jsvalue.Object, error) {
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
func parseCellRange(cells string, fail func(plugins.ErrorCode, string, string) error) (bounds, error) {
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
func gridRange(sheetID int64, b bounds) *jsvalue.Object {
	g := obj("sheetId", sheetID)
	setIndex(g, "startRowIndex", b.startRow)
	setIndex(g, "endRowIndex", b.endRow)
	setIndex(g, "startColumnIndex", b.startCol)
	setIndex(g, "endColumnIndex", b.endCol)
	return g
}
