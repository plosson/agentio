import { mkdir, unlink } from 'fs/promises';
import { join, extname } from 'path';
import type { chat_v1 } from '@googleapis/chat';
import { CliError } from '../../../utils/errors';
import type {
  GChatAttachment,
  GChatAttachmentsResult,
  GChatManifestEntry,
  GChatMessage,
  GChatSender,
} from './types';

/** What `agentio gchat` asks for when Drive downloads are refused. */
export const DRIVE_REAUTH_HINT =
  'Drive attachments need the drive.readonly scope: run `agentio profile reauth gchat <profile>`';

// ---------------------------------------------------------------------------
// Resource names
// ---------------------------------------------------------------------------

/**
 * `AAAA1234`, `spaces/AAAA1234` and `spaces/AAAA1234/` all become `AAAA1234`.
 * Anything without the prefix is a display name and passes through untouched.
 */
export function normalizeSpaceId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith('spaces/')) return trimmed;
  const id = trimmed.slice('spaces/'.length).replace(/\/+$/, '');
  if (!id || id.includes('/')) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid space: "${input}"`,
      'Pass a space ID ("AAAA1234"), its resource name ("spaces/AAAA1234") or a display name'
    );
  }
  return id;
}

/**
 * The bare id from a message or thread id, or from its full
 * `spaces/X/<collection>/Y` name. A name from another space or collection is
 * rejected rather than silently resolved against `spaceId`.
 */
function childId(spaceId: string, input: string, collection: 'messages' | 'threads'): string {
  const label = collection === 'messages' ? 'message' : 'thread';
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new CliError('INVALID_PARAMS', `Empty ${label} ID`);
  }
  if (!trimmed.includes('/')) return trimmed;
  const match = trimmed.match(/^spaces\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match || match[2] !== collection) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid ${label} ID: "${input}"`,
      `Pass a ${label} ID ("abcDEF") or its resource name ("spaces/AAAA1234/${collection}/abcDEF")`
    );
  }
  if (match[1] !== spaceId) {
    throw new CliError(
      'INVALID_PARAMS',
      `${label[0].toUpperCase()}${label.slice(1)} "${input}" belongs to space ${match[1]}, not ${spaceId}`,
      `Use --space ${match[1]}`
    );
  }
  return match[3];
}

/** A message id, or a full `spaces/X/messages/Y` name in `spaceId`, becomes the bare message id. */
export function normalizeMessageId(spaceId: string, input: string): string {
  return childId(spaceId, input, 'messages');
}

/** A thread id, or a full `spaces/X/threads/Y` name in `spaceId`, becomes the thread resource name. */
export function threadResourceName(spaceId: string, input: string): string {
  return `spaces/${spaceId}/threads/${childId(spaceId, input, 'threads')}`;
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

function mapAttachment(a: chat_v1.Schema$Attachment): GChatAttachment {
  const out: GChatAttachment = { name: a.name || '' };
  if (a.contentName) out.contentName = a.contentName;
  if (a.contentType) out.contentType = a.contentType;
  if (a.source) out.source = a.source;
  if (a.attachmentDataRef?.resourceName) out.attachmentDataRef = { resourceName: a.attachmentDataRef.resourceName };
  if (a.driveDataRef?.driveFileId) out.driveDataRef = { driveFileId: a.driveDataRef.driveFileId };
  if (a.thumbnailUri) out.thumbnailUri = a.thumbnailUri;
  if (a.downloadUri) out.downloadUri = a.downloadUri;
  return out;
}

/** The Chat API message as agentio prints it, with attachments, cards and annotations kept. */
export function mapChatMessage(msg: chat_v1.Schema$Message, sender: GChatSender | undefined): GChatMessage {
  const out: GChatMessage = {
    name: msg.name || '',
    createTime: msg.createTime || new Date().toISOString(),
    updateTime: msg.lastUpdateTime || msg.createTime || new Date().toISOString(),
  };
  if (msg.text) out.text = msg.text;
  out.sender = sender;
  if (msg.thread?.name) out.thread = { name: msg.thread.name };
  if (msg.attachment?.length) out.attachment = msg.attachment.map(mapAttachment);
  if (msg.cardsV2?.length) out.cardsV2 = msg.cardsV2;
  if (msg.annotations?.length) out.annotations = msg.annotations;
  if (msg.attachedGifs?.length) out.attachedGifs = msg.attachedGifs;
  return out;
}

/** One short line per attachment / card / gif, so a text-less message still shows what it holds. */
export function messageMarkers(msg: GChatMessage): string[] {
  const markers: string[] = [];
  for (const a of msg.attachment || []) {
    const label = a.contentName || a.name.split('/').pop() || 'file';
    const kind = attachmentKind(a) === 'drive' ? 'drive' : undefined;
    const meta = [a.contentType, kind].filter(Boolean).join(', ');
    markers.push(meta ? `[attachment: ${label} (${meta})]` : `[attachment: ${label}]`);
  }
  if (msg.cardsV2?.length) markers.push(`[cards: ${msg.cardsV2.length}]`);
  if (msg.attachedGifs?.length) markers.push(`[gif: ${msg.attachedGifs.length}]`);
  return markers;
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

/** Keep a name portable: no path separators, control or shell-hostile characters, bounded length. */
export function sanitizeFilenamePart(input: string, maxLength = 120): string {
  let s = input
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[ .]+$/, '');
  if (s.length > maxLength) {
    const ext = extname(s);
    const keep = ext.length > 0 && ext.length <= 10 ? ext : '';
    s = s.slice(0, maxLength - keep.length).trimEnd() + keep;
  }
  return s;
}

/** `<YYYY-MM-DD>_<sender>_<contentName>`, every part sanitized. */
export function buildAttachmentFilename(createTime: string, sender: string, contentName: string): string {
  const date = /^\d{4}-\d{2}-\d{2}/.test(createTime) ? createTime.slice(0, 10) : 'unknown-date';
  const who = sanitizeFilenamePart(sender, 60).replace(/ /g, '-') || 'unknown';
  const what = sanitizeFilenamePart(contentName) || 'attachment';
  return `${date}_${who}_${what}`;
}

/**
 * Returns `name`, or `name (2).ext`, `name (3).ext`… so that no two files in one run collide.
 * Comparison ignores case, since macOS and Windows file systems do.
 */
export function dedupeFilename(name: string, used: Set<string>): string {
  let candidate = name;
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${stem} (${n})${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// ---------------------------------------------------------------------------
// Download routing
// ---------------------------------------------------------------------------

export type AttachmentKind = 'uploaded' | 'drive' | 'none';

export function attachmentKind(a: GChatAttachment): AttachmentKind {
  if (a.source === 'DRIVE_FILE' || a.driveDataRef?.driveFileId) {
    return a.driveDataRef?.driveFileId ? 'drive' : 'none';
  }
  if (a.attachmentDataRef?.resourceName) return 'uploaded';
  return 'none';
}

/** Chat media download URL for an uploaded attachment's `attachmentDataRef.resourceName`. */
export function mediaDownloadUrl(resourceName: string): string {
  const path = resourceName.split('/').map(encodeURIComponent).join('/');
  return `https://chat.googleapis.com/v1/media/${path}?alt=media`;
}

export function driveMetadataUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType,name&supportsAllDrives=true`;
}

export function driveMediaUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

export function driveExportUrl(fileId: string, mimeType: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`;
}

/** Google-native Drive types have no bytes of their own; they are exported to these formats. */
export const DRIVE_EXPORTS: Record<string, { mimeType: string; extension: string }> = {
  'application/vnd.google-apps.document': {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extension: '.xlsx',
  },
  'application/vnd.google-apps.presentation': {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extension: '.pptx',
  },
  'application/vnd.google-apps.drawing': { mimeType: 'image/png', extension: '.png' },
  'application/vnd.google-apps.script': { mimeType: 'application/vnd.google-apps.script+json', extension: '.json' },
};

export interface DownloadPlan {
  url: string;
  /** Extension to add to the file name when it lacks one (Drive exports). */
  extension?: string;
}

/** Where a Drive file's bytes come from: `alt=media` for real files, `export` for Google-native ones. */
export function planDriveDownload(fileId: string, mimeType: string | undefined): DownloadPlan {
  if (mimeType && mimeType.startsWith('application/vnd.google-apps.')) {
    const exp = DRIVE_EXPORTS[mimeType];
    if (!exp) {
      throw new Error(`Google ${mimeType.replace('application/vnd.google-apps.', '')} files cannot be downloaded or exported`);
    }
    return { url: driveExportUrl(fileId, exp.mimeType), extension: exp.extension };
  }
  return { url: driveMediaUrl(fileId) };
}

export interface DownloadDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  getAccessToken: () => Promise<string>;
  /** False when the stored grant is known to lack Drive read access: Drive files fail fast with the reauth hint. */
  driveAllowed?: boolean;
}

/** Whether a granted scope string (space-separated) can read Drive files. Unknown grants are assumed to. */
export function grantAllowsDrive(scope: string | undefined): boolean {
  if (!scope) return true;
  return scope.split(/\s+/).some(s =>
    s === 'https://www.googleapis.com/auth/drive.readonly' || s === 'https://www.googleapis.com/auth/drive'
  );
}

async function authorizedGet(url: string, deps: DownloadDeps): Promise<Response> {
  const token = await deps.getAccessToken();
  return deps.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

async function describeFailure(res: Response, kind: AttachmentKind): Promise<string> {
  let detail = '';
  try {
    const body = await res.text();
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    detail = parsed.error?.message || body.slice(0, 200);
  } catch {
    // keep detail empty
  }
  const base = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
  if (kind === 'drive' && (res.status === 401 || res.status === 403)) {
    return `${base}. ${DRIVE_REAUTH_HINT}, and check you can open the file in Drive`;
  }
  return base;
}

/**
 * Opens the byte stream of one attachment. Uploaded files go through the Chat
 * media API; Drive files through Drive `files.get alt=media` or `files.export`.
 */
export async function openAttachment(
  a: GChatAttachment,
  deps: DownloadDeps
): Promise<{ response: Response; extension?: string }> {
  const kind = attachmentKind(a);
  if (kind === 'none') {
    throw new Error('Attachment has no downloadable reference (no attachmentDataRef or driveDataRef)');
  }

  if (kind === 'drive' && deps.driveAllowed === false) {
    throw new Error(`This profile was signed in without Drive access. ${DRIVE_REAUTH_HINT}`);
  }

  let plan: DownloadPlan;
  if (kind === 'uploaded') {
    plan = { url: mediaDownloadUrl(a.attachmentDataRef!.resourceName!) };
  } else {
    const fileId = a.driveDataRef!.driveFileId!;
    let mimeType = a.contentType;
    if (!mimeType || !mimeType.startsWith('application/vnd.google-apps.')) {
      // The Chat attachment's contentType is not always the Drive type; ask Drive.
      const meta = await authorizedGet(driveMetadataUrl(fileId), deps);
      if (!meta.ok) throw new Error(await describeFailure(meta, kind));
      mimeType = ((await meta.json()) as { mimeType?: string }).mimeType || mimeType;
    }
    plan = planDriveDownload(fileId, mimeType);
  }

  const res = await authorizedGet(plan.url, deps);
  if (!res.ok) throw new Error(await describeFailure(res, kind));
  return { response: res, extension: plan.extension };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const MANIFEST_COLUMNS: (keyof GChatManifestEntry)[] = [
  'messageName', 'createTime', 'sender', 'senderEmail', 'attachmentName',
  'contentName', 'contentType', 'source', 'savedPath', 'status', 'bytes', 'error',
];

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function manifestToCsv(entries: GChatManifestEntry[]): string {
  const lines = [MANIFEST_COLUMNS.join(',')];
  for (const e of entries) lines.push(MANIFEST_COLUMNS.map(c => csvCell(e[c])).join(','));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// The export run
// ---------------------------------------------------------------------------

export interface ExportRunOptions {
  outDir: string;
  dryRun?: boolean;
  concurrency?: number;
  onProgress?: (entry: GChatManifestEntry, index: number) => void;
}

function senderLabel(sender: GChatSender | undefined): string {
  if (!sender) return 'unknown';
  if (sender.displayName && sender.displayName !== sender.name) return sender.displayName;
  if (sender.email) return sender.email.split('@')[0];
  return sender.name.replace(/^users\//, '') || 'unknown';
}

/**
 * Walks every message, saves each attachment into `outDir` and writes
 * manifest.json / manifest.csv. A failed file is recorded and the run goes on.
 */
export async function exportAttachments(
  messages: AsyncIterable<GChatMessage>,
  options: ExportRunOptions,
  deps: DownloadDeps
): Promise<GChatAttachmentsResult> {
  await mkdir(options.outDir, { recursive: true });
  const used = new Set<string>(['manifest.json', 'manifest.csv']);
  const entries: GChatManifestEntry[] = [];
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const inFlight = new Set<Promise<void>>();
  let messagesScanned = 0;
  let messagesWithAttachments = 0;

  const save = async (entry: GChatManifestEntry, a: GChatAttachment, baseName: string, index: number) => {
    let path: string | undefined;
    try {
      const { response, extension } = await openAttachment(a, deps);
      let fileName = baseName;
      if (extension && extname(fileName).toLowerCase() !== extension) {
        // Re-dedupe with the export extension added; release the extension-less name.
        used.delete(baseName.toLowerCase());
        fileName = dedupeFilename(baseName + extension, used);
      }
      path = join(options.outDir, fileName);
      entry.savedPath = path;
      entry.bytes = await Bun.write(path, response);
      entry.status = 'saved';
    } catch (err) {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      if (path) await unlink(path).catch(() => {});
    }
    options.onProgress?.(entry, index);
  };

  for await (const msg of messages) {
    messagesScanned++;
    if (!msg.attachment?.length) continue;
    messagesWithAttachments++;
    const who = senderLabel(msg.sender);

    for (const a of msg.attachment) {
      const contentName = a.contentName || a.name.split('/').pop() || 'attachment';
      const baseName = dedupeFilename(buildAttachmentFilename(msg.createTime, who, contentName), used);
      const entry: GChatManifestEntry = {
        messageName: msg.name,
        createTime: msg.createTime,
        sender: who,
        senderEmail: msg.sender?.email,
        attachmentName: a.name,
        contentName,
        contentType: a.contentType || '',
        source: a.source || (attachmentKind(a) === 'drive' ? 'DRIVE_FILE' : 'UPLOADED_CONTENT'),
        savedPath: join(options.outDir, baseName),
        status: 'planned',
      };
      const index = entries.length;
      entries.push(entry);

      if (options.dryRun) {
        options.onProgress?.(entry, index);
        continue;
      }
      const p = save(entry, a, baseName, index).finally(() => inFlight.delete(p));
      inFlight.add(p);
      if (inFlight.size >= concurrency) await Promise.race(inFlight);
    }
  }
  await Promise.all(inFlight);

  const manifestJson = join(options.outDir, 'manifest.json');
  const manifestCsv = join(options.outDir, 'manifest.csv');
  await Bun.write(manifestJson, JSON.stringify(entries, null, 2) + '\n');
  await Bun.write(manifestCsv, manifestToCsv(entries));

  return {
    outDir: options.outDir,
    messagesScanned,
    messagesWithAttachments,
    attachments: entries.length,
    saved: entries.filter(e => e.status === 'saved').length,
    failed: entries.filter(e => e.status === 'failed').length,
    manifestJson,
    manifestCsv,
    entries,
  };
}
