package gslides

import (
	"context"
	"io"
	"net/url"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	drive "google.golang.org/api/drive/v3"
	slides "google.golang.org/api/slides/v1"
)

const (
	presentationMimeType = "application/vnd.google-apps.presentation"
	presentationURL      = "https://docs.google.com/presentation/d/"
)

// exportMimeTypes is GSlidesClient.export's formatMap.
var exportMimeTypes = map[string]string{
	"pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"pdf":  "application/pdf",
	"odp":  "application/vnd.oasis.opendocument.presentation",
}

// slideInfo is GSlidesSlideInfo: Title is absent when the slide has none.
type slideInfo struct {
	Index    int    `json:"index"`
	ObjectID string `json:"objectId"`
	Title    string `json:"title,omitempty"`
}

// presentation is GSlidesPresentation: Width and Height are absent when the
// page size has no magnitude.
type presentation struct {
	ID         string      `json:"id"`
	Title      string      `json:"title"`
	URL        string      `json:"url"`
	SlideCount int         `json:"slideCount"`
	Width      *float64    `json:"width,omitempty"`
	Height     *float64    `json:"height,omitempty"`
	Slides     []slideInfo `json:"slides"`
}

// element is GSlidesElement.
type element struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// slideContent is GSlidesSlideContent.
type slideContent struct {
	Index    int       `json:"index"`
	ObjectID string    `json:"objectId"`
	Elements []element `json:"elements"`
	Notes    string    `json:"notes"`
}

// created is GSlidesCreateResult (create and copy).
type created struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
}

// batched is GSlidesBatchResult.
type batched struct {
	Replies        int    `json:"replies"`
	PresentationID string `json:"presentationId"`
}

// api is GSlidesClient. Reads and simple writes go through the typed
// slides/v1 and drive/v3 clients. batchUpdate carries the caller's JSON, so it
// is sent as ordered JSON at the slides client's BasePath.
type api struct {
	ctx    context.Context
	run    *plugins.RunContext
	slides *slides.Service
	drive  *drive.Service
	fail   func(code plugins.ErrorCode, message, suggestion string) error
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	driveSvc, err := google.DriveService(ctx, run)
	if err != nil {
		return nil, err
	}
	slidesSvc, err := google.NewService(ctx, run, google.Camel, slides.NewService)
	if err != nil {
		return nil, err
	}
	return &api{ctx: ctx, run: run, slides: slidesSvc, drive: driveSvc, fail: run.Fail}, nil
}

// apiError is GSlidesClient.throwApiError.
func (a *api) apiError(operation string, err error) error {
	message := google.StatusMessage(err, "Insufficient permissions to access this presentation", "Presentation not found")
	return a.fail(google.ErrorCode(err), "Failed to "+operation+": "+message, "")
}

var (
	presentationURLPattern = regexp.MustCompile(`/presentation/d/([a-zA-Z0-9_-]+)`)
	presentationIDPattern  = regexp.MustCompile(`id=([a-zA-Z0-9_-]+)`)
)

// extractPresentationID accepts an ID, a /presentation/d/<id> URL or an id= URL.
func extractPresentationID(idOrURL string) string {
	if m := presentationURLPattern.FindStringSubmatch(idOrURL); m != nil {
		return m[1]
	}
	if m := presentationIDPattern.FindStringSubmatch(idOrURL); m != nil {
		return m[1]
	}
	return idOrURL
}

func (a *api) list(limit float64, query string) ([]google.DriveFile, error) {
	files, err := google.ListDriveFiles(a.ctx, a.drive, presentationMimeType, query, limit, presentationURL)
	if err != nil {
		return nil, a.apiError("list presentations", err)
	}
	return files, nil
}

// magnitude is `dimension?.magnitude ?? undefined`.
func magnitude(d *slides.Dimension) *float64 {
	if d == nil || d.Magnitude == 0 {
		return nil
	}
	m := d.Magnitude
	return &m
}

func (a *api) metadata(idOrURL string) (*presentation, error) {
	resp, err := a.slides.Presentations.Get(extractPresentationID(idOrURL)).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("get presentation metadata", err)
	}
	out := &presentation{ID: resp.PresentationId, Title: resp.Title, URL: presentationURL + resp.PresentationId, Slides: []slideInfo{}}
	if out.Title == "" {
		out.Title = "Untitled"
	}
	if size := resp.PageSize; size != nil {
		out.Width, out.Height = magnitude(size.Width), magnitude(size.Height)
	}
	for i, s := range resp.Slides {
		out.Slides = append(out.Slides, slideInfo{Index: i, ObjectID: s.ObjectId, Title: slideTitle(s)})
	}
	out.SlideCount = len(out.Slides)
	return out, nil
}

// get is the text of every slide, or of the one at slide (a parseInt result:
// NaN reads past the list, as Bun's allSlides[NaN] does).
func (a *api) get(idOrURL string, slide *float64) ([]slideContent, error) {
	resp, err := a.slides.Presentations.Get(extractPresentationID(idOrURL)).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("get slide content", err)
	}
	all := resp.Slides
	if slide == nil {
		out := []slideContent{}
		for i, s := range all {
			out = append(out, parseSlide(s, i))
		}
		return out, nil
	}
	n := *slide
	last := jsvalue.NumberString(float64(len(all) - 1))
	if n < 0 || n >= float64(len(all)) {
		return nil, a.fail("INVALID_PARAMS", "Slide index "+jsvalue.NumberString(n)+" out of range (0–"+last+")", "Use --slide 0 to "+last)
	}
	if n != n {
		// parseSlide(undefined) throws a TypeError, reported as an API failure.
		return nil, a.fail("API_ERROR", "Failed to get slide content: undefined is not an object (evaluating 'slide.pageElements')", "")
	}
	return []slideContent{parseSlide(all[int(n)], int(n))}, nil
}

func (a *api) create(title string) (*created, error) {
	body := &slides.Presentation{Title: title, ForceSendFields: []string{"Title"}}
	resp, err := a.slides.Presentations.Create(body).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("create presentation", err)
	}
	out := &created{ID: resp.PresentationId, Title: resp.Title, URL: presentationURL + resp.PresentationId}
	if out.Title == "" {
		out.Title = title
	}
	return out, nil
}

func (a *api) copy(idOrURL, title, parentFolderID string) (*created, error) {
	file := &drive.File{Name: title}
	if parentFolderID != "" {
		file.Parents = []string{parentFolderID}
	}
	f, err := a.drive.Files.Copy(extractPresentationID(idOrURL), file).Fields("id,name,webViewLink").Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("copy presentation", err)
	}
	out := &created{ID: f.Id, Title: f.Name, URL: f.WebViewLink}
	if out.Title == "" {
		out.Title = title
	}
	if out.URL == "" {
		out.URL = presentationURL + f.Id
	}
	return out, nil
}

// export is the Drive export bytes of the presentation as mimeType.
func (a *api) export(idOrURL, mimeType string) ([]byte, error) {
	resp, err := a.drive.Files.Export(extractPresentationID(idOrURL), mimeType).Context(a.ctx).Download()
	if err != nil {
		return nil, a.apiError("export presentation", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, a.apiError("export presentation", err)
	}
	return body, nil
}

func (a *api) batch(idOrURL string, requests []any) (*batched, error) {
	id := extractPresentationID(idOrURL)
	if len(requests) == 0 {
		return nil, a.fail("INVALID_PARAMS", "requests must be a non-empty array", "")
	}
	body := jsvalue.NewObject()
	body.Set("requests", requests)
	v, err := google.CallJSON(a.ctx, a.run, google.Camel, "POST", a.slides.BasePath, "v1/presentations/"+url.PathEscape(id)+":batchUpdate", jsvalue.Stringify(body))
	if err != nil {
		return nil, a.apiError("execute batch update", err)
	}
	out := &batched{PresentationID: id}
	if resp, ok := v.(*jsvalue.Object); ok {
		replies, _ := resp.Get("replies")
		items, _ := replies.([]any)
		out.Replies = len(items)
	}
	return out, nil
}

func parseSlide(s *slides.Page, index int) slideContent {
	out := slideContent{Index: index, ObjectID: s.ObjectId, Elements: []element{}, Notes: notes(s)}
	for _, el := range s.PageElements {
		if el != nil && el.Shape != nil && el.Shape.Text != nil {
			if text := textContent(el.Shape.Text); text != "" {
				out.Elements = append(out.Elements, element{Type: "text", Text: text})
			}
		}
	}
	return out
}

// notes is extractNotes: the first non-empty BODY placeholder on the notes page.
func notes(s *slides.Page) string {
	if s.SlideProperties == nil || s.SlideProperties.NotesPage == nil {
		return ""
	}
	for _, el := range s.SlideProperties.NotesPage.PageElements {
		if placeholderType(el) == "BODY" && el.Shape.Text != nil {
			if text := textContent(el.Shape.Text); text != "" {
				return text
			}
		}
	}
	return ""
}

// slideTitle is extractSlideTitle: the text of the first TITLE or
// CENTERED_TITLE placeholder, empty when there is none.
func slideTitle(s *slides.Page) string {
	for _, el := range s.PageElements {
		if t := placeholderType(el); (t == "TITLE" || t == "CENTERED_TITLE") && el.Shape.Text != nil {
			return textContent(el.Shape.Text)
		}
	}
	return ""
}

func placeholderType(el *slides.PageElement) string {
	if el == nil || el.Shape == nil || el.Shape.Placeholder == nil {
		return ""
	}
	return el.Shape.Placeholder.Type
}

// textContent is extractTextContent: the text runs joined, one trailing
// newline dropped, then trimmed.
func textContent(t *slides.TextContent) string {
	var b strings.Builder
	for _, el := range t.TextElements {
		if el != nil && el.TextRun != nil {
			b.WriteString(el.TextRun.Content)
		}
	}
	return jsvalue.Trim(strings.TrimSuffix(b.String(), "\n"))
}
