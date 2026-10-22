import { dedupeFilename, sanitizeFilenamePart } from '../gchat/attachments';
import { resolveInside } from '../../../utils/safe-path';

/** Used when an attachment name is empty, or nothing is left of it after sanitising. */
export const FALLBACK_ATTACHMENT_NAME = 'attachment';

/**
 * A sender-chosen attachment name made safe to write as one file: no path
 * separators (`/` and `\` become `_`), no control characters, no leading dots,
 * never empty, `.` or `..`.
 */
export function safeAttachmentName(raw: string | undefined | null): string {
  const cleaned = sanitizeFilenamePart(raw ?? '');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? FALLBACK_ATTACHMENT_NAME : cleaned;
}

/**
 * Where each attachment of one message goes: sanitised, deduplicated within the
 * batch (case-insensitively, `name (2).ext`), and verified to stay inside
 * `outputDir`. Throws INVALID_PARAMS rather than ever returning a path outside it.
 */
export function attachmentOutputPaths(outputDir: string, filenames: Array<string | undefined | null>): string[] {
  const used = new Set<string>();
  return filenames.map((raw) => resolveInside(outputDir, dedupeFilename(safeAttachmentName(raw), used)));
}
