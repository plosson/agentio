package gslides

import (
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// The printers read the Bun objects the client builds, as Bun's template
// strings do: a missing field prints "undefined".

// emuPerInch converts page size magnitudes (EMU) to inches.
const emuPerInch = 914400

// formatMetadata is printGSlidesMetadata.
func formatMetadata(p any) string {
	lines := []string{"ID: " + google.Field(p, "id"), "Title: " + google.Field(p, "title"), "URL: " + google.Field(p, "url"), "Slides: " + google.Field(p, "slideCount")}
	width, height := jsvalue.Member(p, "width"), jsvalue.Member(p, "height")
	if width != jsvalue.Undefined && height != jsvalue.Undefined {
		lines = append(lines, "Dimensions: "+jsvalue.ToFixed(jsvalue.ToNumber(width)/emuPerInch, 2)+`" × `+jsvalue.ToFixed(jsvalue.ToNumber(height)/emuPerInch, 2)+`"`)
	}
	if slides, _ := jsvalue.Member(p, "slides").([]any); len(slides) > 0 {
		lines = append(lines, "", "Slide index:")
		for _, s := range slides {
			title := ""
			if google.Truthy(s, "title") {
				title = " — " + google.Field(s, "title")
			}
			lines = append(lines, "  ["+google.Field(s, "index")+"] "+google.Field(s, "objectId")+title)
		}
	}
	return strings.Join(lines, "\n")
}

// formatContent is printGSlidesContent.
func formatContent(v any) string {
	slides, _ := v.([]any)
	if len(slides) == 0 {
		return "No slides found"
	}
	var lines []string
	for _, s := range slides {
		lines = append(lines, "\n--- Slide "+jsvalue.NumberString(jsvalue.ToNumber(jsvalue.Member(s, "index"))+1)+" ("+google.Field(s, "objectId")+") ---")
		elements, _ := jsvalue.Member(s, "elements").([]any)
		if len(elements) == 0 {
			lines = append(lines, "(no text content)")
		}
		for _, e := range elements {
			lines = append(lines, google.Field(e, "text"))
		}
		if google.Truthy(s, "notes") {
			lines = append(lines, "\nNotes:", google.Field(s, "notes"))
		}
	}
	return strings.Join(lines, "\n")
}

// formatCreated is printGSlidesCreated (create and copy).
func formatCreated(v any) string { return google.FormatCreatedFile(v, "Presentation created") }

// formatBatch is printGSlidesBatchResult.
func formatBatch(b any) string {
	return "Batch update applied to " + google.Field(b, "presentationId") + "\n  Replies: " + google.Field(b, "replies")
}
