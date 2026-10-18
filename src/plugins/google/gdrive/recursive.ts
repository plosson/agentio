import type { drive_v3 } from '@googleapis/drive';
import { CliError } from '../../../utils/errors';
import type { GDriveFile, GDriveRecursiveOptions } from './types';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** Every field agentio shows for a file, so one list call carries all of it. */
export const FILE_FIELDS =
  'id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,owners(displayName,emailAddress),parents,webViewLink,webContentLink,starred,trashed,shared,description,shortcutDetails(targetId,targetMimeType)';

/** Drive's largest page; fewer round trips on big folders. */
export const PAGE_SIZE = 1000;

export interface ChildPage {
  files: drive_v3.Schema$File[];
  nextPageToken?: string;
}

/** One page of a folder's children matching `q` (already including the parent clause). */
export type ListPage = (q: string, pageToken: string | undefined, fields: string) => Promise<ChildPage>;

const quote = (id: string) => id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function childQuery(folderId: string, opts: { query?: string; includeTrash?: boolean; foldersOnly?: boolean }): string {
  const parts = [`'${quote(folderId)}' in parents`];
  if (!opts.includeTrash) parts.push('trashed = false');
  if (opts.foldersOnly) parts.push(`(mimeType = '${FOLDER_MIME}' or mimeType = '${SHORTCUT_MIME}')`);
  if (opts.query) parts.push(`(${opts.query})`);
  return parts.join(' and ');
}

export function parseMaxDepth(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError('INVALID_PARAMS', `Invalid --max-depth: ${value}`, 'Use a whole number from 1 (direct children only)');
  }
  return n;
}

const isFolder = (f: drive_v3.Schema$File) => f.mimeType === FOLDER_MIME;
const isFolderShortcut = (f: drive_v3.Schema$File) =>
  f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetMimeType === FOLDER_MIME && !!f.shortcutDetails.targetId;

/**
 * Walks a folder breadth-first, page by page, handing each item to `emit`
 * with its path below the start and its depth. Each folder is entered once
 * (cutting cycles and repeats); shortcuts to folders are listed but entered
 * only with `followShortcuts`. With a `query`, the listed items come from the
 * filtered query, and a second, folders-only query finds where to go next.
 * Returns whether the walk stopped at `limit`.
 */
export async function walkFolder(
  listPage: ListPage,
  startId: string,
  opts: GDriveRecursiveOptions,
  emit: (file: drive_v3.Schema$File, path: string, depth: number) => void,
): Promise<{ truncated: boolean; folders: number }> {
  const limit = opts.limit ?? Infinity;
  const maxDepth = opts.maxDepth ?? Infinity;
  const visited = new Set<string>([startId]);
  const queue: { id: string; path: string; depth: number }[] = [{ id: startId, path: '', depth: 1 }];
  let emitted = 0;
  let folders = 0;

  const pages = async function* (q: string, fields: string) {
    let token: string | undefined;
    do {
      const page = await listPage(q, token, fields);
      yield page.files;
      token = page.nextPageToken || undefined;
    } while (token);
  };

  while (queue.length) {
    const folder = queue.shift()!;
    folders++;
    const descend = folder.depth < maxDepth;
    const enqueue = (f: drive_v3.Schema$File, path: string) => {
      if (!descend) return;
      const target = isFolder(f) ? f.id : opts.followShortcuts && isFolderShortcut(f) ? f.shortcutDetails!.targetId : null;
      if (!target || visited.has(target)) return;
      visited.add(target);
      queue.push({ id: target, path, depth: folder.depth + 1 });
    };
    const pathOf = (f: drive_v3.Schema$File) => (folder.path ? `${folder.path}/` : '') + (f.name || f.id);

    for await (const files of pages(childQuery(folder.id, opts), `nextPageToken,files(${FILE_FIELDS})`)) {
      for (const f of files) {
        if (emitted >= limit) return { truncated: true, folders };
        emit(f, pathOf(f), folder.depth);
        emitted++;
        if (!opts.query) enqueue(f, pathOf(f));
      }
    }
    if (opts.query && descend) {
      const sub = childQuery(folder.id, { includeTrash: opts.includeTrash, foldersOnly: true });
      for await (const files of pages(sub, 'nextPageToken,files(id,name,mimeType,shortcutDetails(targetId,targetMimeType))')) {
        for (const f of files) enqueue(f, pathOf(f));
      }
    }
  }
  return { truncated: false, folders };
}

/** What `--fields` may add to the text listing. */
export const TEXT_FIELDS = ['md5', 'bytes', 'modified', 'created', 'mime', 'owners', 'parents', 'path', 'link', 'target'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

export function parseTextFields(value: string | undefined): TextField[] {
  if (!value) return [];
  const fields = value.split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
  const unknown = fields.filter((f) => !(TEXT_FIELDS as readonly string[]).includes(f));
  if (unknown.length) {
    throw new CliError('INVALID_PARAMS', `Unknown --fields: ${unknown.join(', ')}`, `Choose from: ${TEXT_FIELDS.join(', ')}`);
  }
  return [...new Set(fields)] as TextField[];
}

export function textFieldValue(file: GDriveFile, field: TextField): string {
  switch (field) {
    case 'md5': return file.md5Checksum ?? '-';
    case 'bytes': return file.size === undefined ? '-' : String(file.size);
    case 'modified': return file.modifiedTime ?? '-';
    case 'created': return file.createdTime ?? '-';
    case 'mime': return file.mimeType;
    case 'owners': return file.owners?.join(';') || '-';
    case 'parents': return file.parents?.join(';') || '-';
    case 'path': return file.path ?? '-';
    case 'link': return file.webViewLink ?? '-';
    case 'target': return file.shortcutDetails?.targetId ?? '-';
  }
}

/** The JSON shape: stable keys, with null where Drive has nothing (md5 of a native Doc, size of a folder). */
export function fileJson(file: GDriveFile): Record<string, unknown> {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size ?? null,
    md5Checksum: file.md5Checksum ?? null,
    modifiedTime: file.modifiedTime ?? null,
    createdTime: file.createdTime ?? null,
    ...(file.path !== undefined ? { path: file.path, depth: file.depth } : {}),
    parents: file.parents ?? [],
    owners: file.owners ?? [],
    starred: file.starred,
    shared: file.shared,
    trashed: file.trashed,
    ...(file.shortcutDetails ? { shortcutDetails: file.shortcutDetails } : {}),
    webViewLink: file.webViewLink ?? null,
    ...(file.description ? { description: file.description } : {}),
  };
}
