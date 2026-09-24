package gslides

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// emuPerInch converts page size magnitudes (EMU) to inches.
const emuPerInch = 914400

// formatMetadata is printGSlidesMetadata.
func formatMetadata(v any) string {
	p, _ := v.(*presentation)
	if p == nil {
		return ""
	}
	lines := []string{"ID: " + p.ID, "Title: " + p.Title, "URL: " + p.URL, fmt.Sprintf("Slides: %d", p.SlideCount)}
	if p.Width != nil && p.Height != nil {
		lines = append(lines, "Dimensions: "+jsvalue.ToFixed(*p.Width/emuPerInch, 2)+`" × `+jsvalue.ToFixed(*p.Height/emuPerInch, 2)+`"`)
	}
	if len(p.Slides) > 0 {
		lines = append(lines, "", "Slide index:")
		for _, s := range p.Slides {
			title := ""
			if s.Title != "" {
				title = " — " + s.Title
			}
			lines = append(lines, fmt.Sprintf("  [%d] %s%s", s.Index, s.ObjectID, title))
		}
	}
	return strings.Join(lines, "\n")
}

// formatContent is printGSlidesContent.
func formatContent(v any) string {
	slides, _ := v.([]slideContent)
	if len(slides) == 0 {
		return "No slides found"
	}
	var lines []string
	for _, s := range slides {
		lines = append(lines, fmt.Sprintf("\n--- Slide %d (%s) ---", s.Index+1, s.ObjectID))
		if len(s.Elements) == 0 {
			lines = append(lines, "(no text content)")
		}
		for _, e := range s.Elements {
			lines = append(lines, e.Text)
		}
		if s.Notes != "" {
			lines = append(lines, "\nNotes:", s.Notes)
		}
	}
	return strings.Join(lines, "\n")
}

// formatCreated is printGSlidesCreated (create and copy).
func formatCreated(v any) string {
	c, _ := v.(*created)
	if c == nil {
		return ""
	}
	return strings.Join([]string{"Presentation created", "ID: " + c.ID, "Title: " + c.Title, "URL: " + c.URL}, "\n")
}

// formatBatch is printGSlidesBatchResult.
func formatBatch(v any) string {
	b, _ := v.(*batched)
	if b == nil {
		return ""
	}
	return fmt.Sprintf("Batch update applied to %s\n  Replies: %d", b.PresentationID, b.Replies)
}
