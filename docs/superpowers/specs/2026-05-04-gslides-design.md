# gslides — Google Slides Command Design

**Date:** 2026-05-04  
**Status:** Approved

## Overview

Add a `gslides` command to agentio CLI following the same pattern as `gdocs` and `gsheets`. The command provides LLM-friendly access to Google Slides: listing presentations, reading slide content as text, exporting files, and a `batchUpdate` escape hatch for programmatic slide manipulation.

## Architecture

Seven-file pattern, identical to every other service:

| File | Purpose |
|------|---------|
| `src/types/gslides.ts` | TypeScript interfaces |
| `src/services/gslides/client.ts` | `GSlidesClient` class |
| `src/commands/gslides.ts` | `registerGSlidesCommands()` |
| `src/utils/output.ts` | Output formatter additions |
| `src/auth/oauth.ts` | `GSLIDES_SCOPES` + type union update |
| `src/types/config.ts` | `gslides` added to `ServiceName` |
| `src/index-program.ts` | `registerGSlidesCommands` import + call |

**New dependency:** `@googleapis/slides` added to `package.json`.

## Commands

### `gslides list [--limit N] [--query Q]`
List recent presentations via Drive API, ordered by `modifiedTime desc`. Accepts the same Drive query syntax as `gdocs list` and `gsheets list`.

### `gslides metadata <id-or-url>`
Call `presentations.get` and return: title, presentation ID, slide count, slide dimensions, and per-slide summary (index, objectId, title shape text if present).

### `gslides get <id-or-url> [--slide N]`
Read slide content as plain text — the primary LLM-readable operation. For each slide (or the one at index `--slide`), extracts:
- All text from shape elements (paragraphs joined with newlines)
- Speaker notes text

Output is structured text, one slide per block. No binary data.

### `gslides export <id-or-url> --output <path> [--format pptx|pdf|odp]`
Download binary file via Drive export API. Default format: `pptx`. Writes to `--output` path.

### `gslides create <title>`
Create a blank presentation via `presentations.create`. Returns id, title, URL.

### `gslides copy <id-or-url> <title> [--parent <folder-id>]`
Copy via Drive `files.copy`. Returns id, title, URL of the new file.

### `gslides batch <id-or-url> [--requests-json <json>] [--file <path>]`
Pass a JSON array of `Request` objects to `presentations.batchUpdate`. Escape hatch for any operation not covered by the other commands (add/delete slides, insert images, update text, etc.). Mutually exclusive: `--requests-json` or `--file`.

### `gslides profile add|list|remove`
Standard OAuth profile management. `add` triggers the OAuth flow and stores credentials under the profile name (defaulting to the account email).

## Client Methods (`GSlidesClient`)

| Method | API call(s) |
|--------|------------|
| `validate()` | `drive.files.list` (1 presentation, MIME filter) |
| `list(options)` | `drive.files.list` with presentation MIME type |
| `metadata(idOrUrl)` | `slides.presentations.get` |
| `get(idOrUrl, slideIndex?)` | `slides.presentations.get`, extract text + notes |
| `export(idOrUrl, format)` | `drive.files.export` |
| `create(title)` | `slides.presentations.create` |
| `copy(idOrUrl, newTitle, parentFolderId?)` | `drive.files.copy` |
| `batch(idOrUrl, requests[])` | `slides.presentations.batchUpdate` |

URL parsing handles `https://docs.google.com/presentation/d/<ID>/...` pattern.

## Types

```typescript
GSlidesCredentials      // accessToken, refreshToken, expiryDate, tokenType, scope, email
GSlidesListItem         // id, title, owner?, createdTime?, modifiedTime?, webViewLink
GSlidesPresentation     // id, title, url, slideCount, width, height, slides: GSlidesSlideInfo[]
GSlidesSlideInfo        // index, objectId, title?
GSlidesSlideContent     // index, objectId, elements: GSlidesElement[], notes: string
GSlidesElement          // type: 'text'|'shape', text: string
GSlidesCreateResult     // id, title, url
GSlidesBatchResult      // replies: number, presentationId: string
GSlidesListOptions      // limit?, query?
```

## OAuth Scopes

```
https://www.googleapis.com/auth/presentations   # read/write slide content
https://www.googleapis.com/auth/drive.file      # create/access files created by this app
https://www.googleapis.com/auth/drive.readonly  # list, export, copy existing files
https://www.googleapis.com/auth/userinfo.email  # profile naming
```

## Output Formatters

Added to `src/utils/output.ts`:

- `printGSlidesList(items)` — table: ID, title, modified, owner
- `printGSlidesMetadata(presentation)` — title, dimensions, slide count, slide index
- `printGSlidesContent(slides)` — text blocks per slide with notes sections
- `printGSlidesCreated(result)` — id, title, URL
- `printGSlidesBatchResult(result)` — reply count, presentation ID

## Error Handling

Same `CliError` pattern as other services. HTTP 403 → `PERMISSION_DENIED`, 404 → `NOT_FOUND`, 401 → `AUTH_FAILED`, 429 → `RATE_LIMITED`.

## Checklist

- [ ] Add `gslides` to `ServiceName` in `src/types/config.ts`
- [ ] Create `src/types/gslides.ts`
- [ ] Install `@googleapis/slides`
- [ ] Create `src/services/gslides/client.ts`
- [ ] Create `src/commands/gslides.ts`
- [ ] Add output formatters to `src/utils/output.ts`
- [ ] Add `GSLIDES_SCOPES` and update `OAuthService` type in `src/auth/oauth.ts`
- [ ] Register in `src/index-program.ts`
- [ ] Run `bun run typecheck` — zero errors
