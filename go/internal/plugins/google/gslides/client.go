package gslides

import (
	"context"
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

// The models are the Bun client's objects (GSlidesPresentation,
// GSlidesSlideContent, GSlidesCreateResult, GSlidesBatchResult), built from
// the answer as JavaScript reads it (google.Answer): a field the answer lacks
// is undefined, and a null slide, element or text run fails with Bun's
// TypeError.

// Bun's transpiler inlines a response read once into the expression its
// TypeError quotes: these are the texts Bun reports for a null answer.
const (
	getDataExpr   = "(await this.slides.presentations.get({ presentationId })).data"
	batchDataExpr = "(await this.slides.presentations.batchUpdate({\n          presentationId,\n          requestBody: { requests }\n        })).data"
)

// api is GSlidesClient. Reads and simple writes go through the typed
// slides/v1 and drive/v3 clients (google.Answer). batchUpdate carries the
// caller's JSON, which the typed Request would drop fields of, so it is sent
// verbatim with google.CallJSON.
type api struct {
	google.API
	slides *slides.Service
	drive  *drive.Service
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
	return &api{API: google.API{Ctx: ctx, RunContext: run, ErrorMessage: errorMessage}, slides: slidesSvc, drive: driveSvc}, nil
}

// errorMessage is GSlidesClient.getErrorMessage.
var errorMessage = google.StatusText("Insufficient permissions to access this presentation", "Presentation not found")

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

func (a *api) list(limit float64, query string) ([]any, error) {
	files, err := google.ListDriveFiles(a.Ctx, a.drive, presentationMimeType, query, limit, presentationURL)
	if err != nil {
		return nil, a.Failed("list presentations", err)
	}
	return files, nil
}

// magnitude is `pageSize?.<dimension>?.magnitude ?? undefined`.
func magnitude(pageSize any, dimension string) any {
	m := jsvalue.Optional(jsvalue.Optional(pageSize, dimension), "magnitude")
	if jsvalue.Nullish(m) {
		return jsvalue.Undefined
	}
	return m
}

// each is `for (const x of v || [])` (or `(v || []).map`) over an answer's list.
func each(v any, text string, visit func(int, any) error) error {
	items, err := jsvalue.Items(jsvalue.Or(v, []any{}), text)
	if err != nil {
		return err
	}
	for i, item := range items {
		if err := visit(i, item); err != nil {
			return err
		}
	}
	return nil
}

// metadata is GSlidesClient.metadata.
func (a *api) metadata(idOrURL string) (*jsvalue.Object, error) {
	out, err := a.readMetadata(idOrURL)
	if err != nil {
		return nil, a.Failed("get presentation metadata", err)
	}
	return out, nil
}

func (a *api) readMetadata(idOrURL string) (*jsvalue.Object, error) {
	_, data, err := google.Answer(a.Ctx, a.slides.Presentations.Get(extractPresentationID(idOrURL)))
	if err != nil {
		return nil, err
	}
	pageSize, err := jsvalue.Path(data, "data", "pageSize")
	if err != nil {
		return nil, err
	}
	infos := []any{}
	err = each(jsvalue.Member(data, "slides"), "(data.slides || [])", func(i int, slide any) error {
		if jsvalue.Nullish(slide) {
			return jsvalue.TypeError(slide, "slide.objectId")
		}
		objectID := jsvalue.Or(jsvalue.Member(slide, "objectId"), "")
		title, err := slideTitle(slide)
		if err != nil {
			return err
		}
		infos = append(infos, jsvalue.ObjectOf("index", i, "objectId", objectID, "title", jsvalue.Or(title, jsvalue.Undefined)))
		return nil
	})
	if err != nil {
		return nil, err
	}
	id := jsvalue.Member(data, "presentationId")
	return jsvalue.ObjectOf(
		"id", id,
		"title", jsvalue.Or(jsvalue.Member(data, "title"), "Untitled"),
		"url", presentationURL+jsvalue.String(id),
		"slideCount", len(infos),
		"width", magnitude(pageSize, "width"),
		"height", magnitude(pageSize, "height"),
		"slides", infos,
	), nil
}

// get is the text of every slide, or of the one at slide (a parseInt result:
// NaN reads past the list, as Bun's allSlides[NaN] does).
func (a *api) get(idOrURL string, slide *float64) ([]any, error) {
	_, data, err := google.Answer(a.Ctx, a.slides.Presentations.Get(extractPresentationID(idOrURL)))
	var all []any
	if err == nil {
		var slides any
		if slides, err = jsvalue.Path(data, getDataExpr, "slides"); err == nil {
			all, err = jsvalue.Items(jsvalue.Or(slides, []any{}), "allSlides")
		}
	}
	if err != nil {
		return nil, a.Failed("get slide content", err)
	}
	out := []any{}
	if slide == nil {
		for i, s := range all {
			parsed, err := parseSlide(s, i)
			if err != nil {
				return nil, a.Failed("get slide content", err)
			}
			out = append(out, parsed)
		}
		return out, nil
	}
	n := *slide
	last := jsvalue.NumberString(float64(len(all) - 1))
	if n < 0 || n >= float64(len(all)) {
		return nil, a.Fail("INVALID_PARAMS", "Slide index "+jsvalue.NumberString(n)+" out of range (0–"+last+")", "Use --slide 0 to "+last)
	}
	picked := jsvalue.Undefined // allSlides[NaN]
	if n == n {
		picked = all[int(n)]
	}
	parsed, err := parseSlide(picked, int(n))
	if err != nil {
		return nil, a.Failed("get slide content", err)
	}
	return append(out, parsed), nil
}

// create is GSlidesClient.create.
func (a *api) create(title string) (*jsvalue.Object, error) {
	body := &slides.Presentation{Title: title, ForceSendFields: []string{"Title"}}
	_, data, err := google.Answer(a.Ctx, a.slides.Presentations.Create(body))
	if err == nil && jsvalue.Nullish(data) {
		err = jsvalue.TypeError(data, "response.data.presentationId")
	}
	if err != nil {
		return nil, a.Failed("create presentation", err)
	}
	id := jsvalue.Member(data, "presentationId")
	return jsvalue.ObjectOf("id", id, "title", jsvalue.Or(jsvalue.Member(data, "title"), title), "url", presentationURL+jsvalue.String(id)), nil
}

// batch is GSlidesClient.batch: replies is `response.data.replies?.length ?? 0`.
func (a *api) batch(idOrURL string, requests []any) (*jsvalue.Object, error) {
	id := extractPresentationID(idOrURL)
	if len(requests) == 0 {
		return nil, a.Fail("INVALID_PARAMS", "requests must be a non-empty array", "")
	}
	body := jsvalue.NewObject()
	body.Set("requests", requests)
	data, err := google.CallJSON(a.Ctx, a.RunContext, google.Camel, "POST", a.slides.BasePath, "v1/presentations/"+url.PathEscape(id)+":batchUpdate", jsvalue.Stringify(body))
	var replies any
	if err == nil {
		replies, err = jsvalue.Path(data, batchDataExpr, "replies")
	}
	if err != nil {
		return nil, a.Failed("execute batch update", err)
	}
	count := jsvalue.Optional(replies, "length")
	if jsvalue.Nullish(count) {
		count = 0
	}
	return jsvalue.ObjectOf("replies", count, "presentationId", id), nil
}

// parseSlide is GSlidesClient.parseSlide.
func parseSlide(slide any, index int) (*jsvalue.Object, error) {
	if jsvalue.Nullish(slide) {
		return nil, jsvalue.TypeError(slide, "slide.pageElements")
	}
	elements := []any{}
	err := each(jsvalue.Member(slide, "pageElements"), "slide.pageElements || []", func(_ int, el any) error {
		if jsvalue.Nullish(el) {
			return jsvalue.TypeError(el, "element.shape")
		}
		if text := jsvalue.Optional(jsvalue.Member(el, "shape"), "text"); jsvalue.Truthy(text) {
			content, err := textContent(text)
			if err != nil {
				return err
			}
			if content != "" {
				elements = append(elements, jsvalue.ObjectOf("type", "text", "text", content))
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	objectID := jsvalue.Or(jsvalue.Member(slide, "objectId"), "")
	notes, err := notesOf(slide)
	if err != nil {
		return nil, err
	}
	return jsvalue.ObjectOf("index", index, "objectId", objectID, "elements", elements, "notes", notes), nil
}

// notesOf is extractNotes: the first non-empty BODY placeholder on the notes page.
func notesOf(slide any) (string, error) {
	notesPage := jsvalue.Optional(jsvalue.Member(slide, "slideProperties"), "notesPage")
	if !jsvalue.Truthy(notesPage) {
		return "", nil
	}
	found := ""
	err := each(jsvalue.Member(notesPage, "pageElements"), "notesPage.pageElements || []", func(_ int, el any) error {
		if found != "" {
			return nil
		}
		if jsvalue.Nullish(el) {
			return jsvalue.TypeError(el, "element.shape")
		}
		shape := jsvalue.Member(el, "shape")
		if placeholderType(shape) == "BODY" && jsvalue.Truthy(jsvalue.Member(shape, "text")) {
			text, err := textContent(jsvalue.Member(shape, "text"))
			if err != nil {
				return err
			}
			found = text
		}
		return nil
	})
	return found, err
}

// slideTitle is extractSlideTitle: the text of the first TITLE or
// CENTERED_TITLE placeholder, null when there is none.
func slideTitle(slide any) (any, error) {
	var title any
	done := false
	err := each(jsvalue.Member(slide, "pageElements"), "slide.pageElements || []", func(_ int, el any) error {
		if done {
			return nil
		}
		if jsvalue.Nullish(el) {
			return jsvalue.TypeError(el, "element.shape")
		}
		shape := jsvalue.Member(el, "shape")
		if t := placeholderType(shape); (t == "TITLE" || t == "CENTERED_TITLE") && jsvalue.Truthy(jsvalue.Optional(shape, "text")) {
			text, err := textContent(jsvalue.Member(shape, "text"))
			if err != nil {
				return err
			}
			title, done = text, true
		}
		return nil
	})
	return title, err
}

// placeholderType is `shape?.placeholder?.type` when it is a string.
func placeholderType(shape any) string {
	t, _ := jsvalue.Optional(jsvalue.Optional(shape, "placeholder"), "type").(string)
	return t
}

// textContent is extractTextContent: the text runs joined, one trailing
// newline dropped, then trimmed.
func textContent(text any) (string, error) {
	var b strings.Builder
	err := each(jsvalue.Member(text, "textElements"), "(textContent.textElements || [])", func(_ int, el any) error {
		if jsvalue.Nullish(el) {
			return jsvalue.TypeError(el, "el.textRun")
		}
		b.WriteString(jsvalue.String(jsvalue.Or(jsvalue.Optional(jsvalue.Member(el, "textRun"), "content"), "")))
		return nil
	})
	return jsvalue.Trim(strings.TrimSuffix(b.String(), "\n")), err
}
