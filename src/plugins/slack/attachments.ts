import { mkdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { buildAttachmentFilename, csvCell, dedupeFilename } from '../google/gchat/attachments';
import { safeAttachmentName } from '../google/gmail/attachment-path';
import { resolveInside } from '../../utils/safe-path';
import type { SlackClient } from './client';
import type {
  SlackAttachmentsResult,
  SlackConversationMessages,
  SlackFile,
  SlackManifestEntry,
  SlackMessage,
  SlackMessagesResult,
} from './types';

export const MANIFEST_COLUMNS: (keyof SlackManifestEntry)[] = [
  'conversationId', 'conversation', 'messageTs', 'time', 'user', 'userName', 'realName', 'permalink',
  'fileId', 'name', 'mimetype', 'size', 'savedPath', 'status', 'bytes', 'error',
];

export function manifestToCsv(entries: SlackManifestEntry[]): string {
  const lines = [MANIFEST_COLUMNS.join(',')];
  for (const e of entries) lines.push(MANIFEST_COLUMNS.map((c) => csvCell(e[c])).join(','));
  return `${lines.join('\n')}\n`;
}

/** Why a file has nothing to download, read from its mode; undefined when it may have. */
export function skipReason(file: SlackFile): string | undefined {
  if (file.mode === 'tombstone') return 'The file was deleted';
  if (file.mode === 'hidden_by_limit') return 'Hidden by the workspace\'s message history limit';
  if (file.mode === 'external') return 'A link to a file stored outside Slack';
  return undefined;
}

/**
 * Where `agentio slack download` writes: --out as given, or inside it when it
 * is a folder (an existing one, or a path ending in /); without --out, the
 * file's own name in the current folder.
 */
export async function downloadTarget(out: string | undefined, fileName: string): Promise<string> {
  const name = safeAttachmentName(fileName);
  if (out === undefined) return resolveInside(process.cwd(), name);
  if (/[\\/]$/.test(out)) {
    await mkdir(out, { recursive: true });
    return resolveInside(out, name);
  }
  const existing = await stat(out).catch(() => undefined);
  return existing?.isDirectory() ? resolveInside(out, name) : out;
}

/** Saves one file; Slack's details are read again first when the message did not carry a download link. */
export async function saveFile(client: SlackClient, file: SlackFile, path: string): Promise<{ bytes: number; file: SlackFile }> {
  const full = file.urlPrivateDownload ? file : await client.fileInfo(file.id);
  const response = await client.downloadFile(full);
  try {
    return { bytes: await Bun.write(path, response), file: full };
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  }
}

export interface SlackExportOptions {
  outDir: string;
  dryRun?: boolean;
  concurrency?: number;
  onProgress?: (entry: SlackManifestEntry, index: number) => void;
}

/** Each message once, replies included, in the order printed. */
function* allMessages(conversation: SlackConversationMessages): Generator<SlackMessage> {
  for (const message of conversation.messages) {
    yield message;
    yield* message.replies;
  }
}

/**
 * Saves every file shared in `result`'s messages into `outDir`, named
 * <YYYY-MM-DD>_<sender>_<file name>, and writes manifest.json and
 * manifest.csv. A file that fails is recorded and the run goes on.
 */
export async function exportSlackAttachments(
  client: SlackClient, result: SlackMessagesResult, options: SlackExportOptions,
): Promise<SlackAttachmentsResult> {
  await mkdir(options.outDir, { recursive: true });
  const used = new Set<string>(['manifest.json', 'manifest.csv']);
  const entries: SlackManifestEntry[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const inFlight = new Set<Promise<void>>();
  let messagesScanned = 0;
  let messagesWithFiles = 0;

  const save = async (entry: SlackManifestEntry, file: SlackFile, index: number) => {
    try {
      entry.bytes = (await saveFile(client, file, entry.savedPath)).bytes;
      entry.status = 'saved';
    } catch (error) {
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
    }
    options.onProgress?.(entry, index);
  };

  for (const conversation of result.conversations) {
    for (const message of allMessages(conversation)) {
      messagesScanned++;
      if (message.files.length === 0) continue;
      messagesWithFiles++;
      const time = new Date(Number(message.ts) * 1000).toISOString();
      const sender = message.realName || message.userName || message.user || 'unknown';
      for (const file of message.files) {
        const fileName = dedupeFilename(buildAttachmentFilename(time, sender, file.name), used);
        const entry: SlackManifestEntry = {
          conversationId: conversation.id,
          conversation: conversation.name,
          messageTs: message.ts,
          time,
          user: message.user,
          userName: message.userName,
          realName: message.realName,
          permalink: message.permalink,
          fileId: file.id,
          name: file.name,
          mimetype: file.mimetype,
          size: file.size,
          savedPath: resolveInside(options.outDir, fileName),
          status: 'planned',
        };
        const index = entries.length;
        entries.push(entry);
        const reason = skipReason(file);
        if (reason) {
          entry.status = 'skipped';
          entry.error = reason;
          options.onProgress?.(entry, index);
          continue;
        }
        if (options.dryRun) {
          options.onProgress?.(entry, index);
          continue;
        }
        const pending = save(entry, file, index).finally(() => inFlight.delete(pending));
        inFlight.add(pending);
        if (inFlight.size >= concurrency) await Promise.race(inFlight);
      }
    }
  }
  await Promise.all(inFlight);

  const manifestJson = join(options.outDir, 'manifest.json');
  const manifestCsv = join(options.outDir, 'manifest.csv');
  await Bun.write(manifestJson, `${JSON.stringify(entries, null, 2)}\n`);
  await Bun.write(manifestCsv, manifestToCsv(entries));

  return {
    outDir: options.outDir,
    messagesScanned,
    messagesWithFiles,
    files: entries.length,
    saved: entries.filter((e) => e.status === 'saved').length,
    failed: entries.filter((e) => e.status === 'failed').length,
    skipped: entries.filter((e) => e.status === 'skipped').length,
    manifestJson,
    manifestCsv,
    entries,
  };
}
