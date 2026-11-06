import { existsSync, statSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve, sep } from 'path';
import { CliError } from '../../utils/errors';
import type { WhatsAppClient } from './client';
import { mediaFileName, safeFileName } from './records';
import type { MessageView } from './types';

/**
 * Saving media files to disk. The daemon fetches and decrypts a file and
 * suggests its name; this side decides where it goes, and never overwrites.
 */

export interface SavedFile {
  path: string;
  contentType: string;
  size: number;
}

/** What became of one message's media during `read --download-media`. */
export type MediaOutcome =
  | { state: 'saved'; file: SavedFile }
  | { state: 'existing'; path: string }
  | { state: 'failed'; error: string };

/**
 * Where a file goes: into `out` when it is a directory or ends with a
 * separator, else at `out` itself; into the current directory without it.
 */
export function outputPath(out: string | undefined, fileName: string): string {
  if (!out) return resolve(fileName);
  if (out.endsWith('/') || out.endsWith(sep) || (existsSync(out) && statSync(out).isDirectory())) return resolve(out, fileName);
  return resolve(out);
}

/** The name the daemon suggested, kept to one safe path segment, or the message ID. */
function suggestedName(suggested: string | undefined, id: string): string {
  return safeFileName(basename(suggested ?? '') || id);
}

/** Write a new file, creating its directory; an existing file is never replaced. */
async function writeNew(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, data, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CliError('INVALID_PARAMS', `${path} already exists`, 'Choose another path with --out, or remove the file');
    }
    throw err;
  }
}

/** Download one message's media and save it at `out` (see outputPath). */
export async function downloadMedia(client: WhatsAppClient, chat: string, id: string, out?: string): Promise<SavedFile> {
  const file = await client.download(chat, id);
  const path = outputPath(out, suggestedName(file.fileName, id));
  await writeNew(path, file.data);
  return { path, contentType: file.contentType, size: file.data.byteLength };
}

/**
 * Save the media of every message that has some into `dir`. A file already
 * there under the same name is left as is, so running it again only fetches
 * what is new. One failure does not stop the others.
 */
export async function saveChatMedia(client: WhatsAppClient, chat: string, messages: MessageView[], dir: string): Promise<Map<string, MediaOutcome>> {
  const outcomes = new Map<string, MediaOutcome>();
  for (const message of messages) {
    if (!message.media) continue;
    // With the MIME type known, the name is known before downloading.
    const expected = message.media.mimetype
      ? resolve(dir, mediaFileName(message, { kind: message.media.type, mimetype: message.media.mimetype, fileName: message.media.fileName }))
      : undefined;
    if (expected && existsSync(expected)) {
      outcomes.set(message.id, { state: 'existing', path: expected });
      continue;
    }
    try {
      const file = await client.download(chat, message.id);
      const path = join(resolve(dir), suggestedName(file.fileName, message.id));
      if (existsSync(path)) {
        outcomes.set(message.id, { state: 'existing', path });
        continue;
      }
      await writeNew(path, file.data);
      outcomes.set(message.id, { state: 'saved', file: { path, contentType: file.contentType, size: file.data.byteLength } });
    } catch (err) {
      outcomes.set(message.id, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return outcomes;
}
