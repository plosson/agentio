import type { GSlidesListItem, GSlidesPresentation, GSlidesSlideContent, GSlidesCreateResult, GSlidesBatchResult } from './types';

// Google Slides specific formatters
export function printGSlidesList(items: GSlidesListItem[]): void {
  if (items.length === 0) {
    console.log('No presentations found');
    return;
  }

  console.log(`Presentations (${items.length})\n`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`[${i + 1}] ${item.title}`);
    console.log(`    ID: ${item.id}`);
    if (item.owner) console.log(`    Owner: ${item.owner}`);
    if (item.modifiedTime) console.log(`    Modified: ${item.modifiedTime}`);
    console.log(`    Link: ${item.webViewLink}`);
    console.log('');
  }
}

export function printGSlidesMetadata(presentation: GSlidesPresentation): void {
  console.log(`ID: ${presentation.id}`);
  console.log(`Title: ${presentation.title}`);
  console.log(`URL: ${presentation.url}`);
  console.log(`Slides: ${presentation.slideCount}`);

  if (presentation.width !== undefined && presentation.height !== undefined) {
    const w = (presentation.width / 914400).toFixed(2);
    const h = (presentation.height / 914400).toFixed(2);
    console.log(`Dimensions: ${w}" × ${h}"`);
  }

  if (presentation.slides.length > 0) {
    console.log('\nSlide index:');
    for (const slide of presentation.slides) {
      const titlePart = slide.title ? ` — ${slide.title}` : '';
      console.log(`  [${slide.index}] ${slide.objectId}${titlePart}`);
    }
  }
}

export function printGSlidesContent(slides: GSlidesSlideContent[]): void {
  if (slides.length === 0) {
    console.log('No slides found');
    return;
  }

  for (const slide of slides) {
    console.log(`\n--- Slide ${slide.index + 1} (${slide.objectId}) ---`);

    if (slide.elements.length > 0) {
      for (const element of slide.elements) {
        console.log(element.text);
      }
    } else {
      console.log('(no text content)');
    }

    if (slide.notes) {
      console.log('\nNotes:');
      console.log(slide.notes);
    }
  }
}

export function printGSlidesCreated(result: GSlidesCreateResult): void {
  console.log('Presentation created');
  console.log(`ID: ${result.id}`);
  console.log(`Title: ${result.title}`);
  console.log(`URL: ${result.url}`);
}

export function printGSlidesBatchResult(result: GSlidesBatchResult): void {
  console.log(`Batch update applied to ${result.presentationId}`);
  console.log(`  Replies: ${result.replies}`);
}
