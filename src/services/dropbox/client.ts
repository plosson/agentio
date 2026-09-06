import { readFile, writeFile, stat, open } from 'fs/promises';
import { basename } from 'path';
import { CliError, httpStatusToErrorCode, type ErrorCode } from '../../utils/errors';
import { normalizeDropboxPath } from '../../types/dropbox';
import type { ServiceClient, ValidationResult } from '../../types/service';
import type {
  DropboxAccount,
  DropboxCredentials,
  DropboxDownloadResult,
  DropboxEntry,
  DropboxLink,
  DropboxListOptions,
  DropboxSearchOptions,
  DropboxUploadOptions,
  DropboxUploadResult,
} from '../../types/dropbox';

const RPC_BASE = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';

/** Single-request uploads are capped at 150 MB; larger files go through a session. */
const SINGLE_UPLOAD_LIMIT = 150 * 1024 * 1024;
/** Dropbox recommends a multiple of 4 MiB for session chunks. */
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
/** Per-call ceiling imposed by files/list_folder. */
const MAX_PAGE_SIZE = 2000;
/** Guard against unbounded paging when a filter matches very little. */
const MAX_PAGES = 50;

interface RawMetadata {
  '.tag'?: string;
  id?: string;
  name?: string;
  path_display?: string;
  path_lower?: string;
  size?: number;
  server_modified?: string;
  rev?: string;
  content_hash?: string;
}

interface ListFolderResponse {
  entries: RawMetadata[];
  cursor: string;
  has_more: boolean;
}

interface SearchResponse {
  matches: Array<{ metadata?: { metadata?: RawMetadata } }>;
  has_more: boolean;
  cursor?: string;
}

interface AccountResponse {
  account_id: string;
  name?: { display_name?: string };
  email: string;
  email_verified?: boolean;
  account_type?: { '.tag'?: string };
  country?: string;
}

function mapEntry(raw: RawMetadata): DropboxEntry {
  const tag = raw['.tag'];
  const type: DropboxEntry['type'] =
    tag === 'folder' ? 'folder' : tag === 'deleted' ? 'deleted' : 'file';

  return {
    type,
    id: raw.id || '',
    name: raw.name || '',
    path: raw.path_display || raw.path_lower || '',
    size: raw.size,
    modified: raw.server_modified,
    rev: raw.rev,
    contentHash: raw.content_hash,
  };
}

/**
 * Dropbox-API-Arg travels in an HTTP header, which is ASCII-only, so every
 * non-ASCII character (accented file names, emoji) has to be \u-escaped.
 */
function headerSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Endpoint-specific failures arrive as 409 with an `error_summary` such as
 * "path/not_found/.", which carries more meaning than the status alone.
 */
function errorCodeFor(status: number, summary: string): ErrorCode {
  if (status === 409) {
    if (summary.includes('not_found')) return 'NOT_FOUND';
    if (summary.includes('conflict')) return 'INVALID_PARAMS';
    if (summary.includes('malformed_path')) return 'INVALID_PARAMS';
    if (summary.includes('insufficient_space')) return 'API_ERROR';
    if (summary.includes('no_write_permission')) return 'PERMISSION_DENIED';
    return 'API_ERROR';
  }
  return httpStatusToErrorCode(status);
}

function suggestionFor(status: number, summary: string): string | undefined {
  if (status === 401) return 'Run: agentio dropbox profile add to re-authorise';
  if (status === 429) return 'Dropbox is rate limiting this app - wait a moment and retry';
  if (summary.includes('conflict')) return 'A file already exists at that path - pass --overwrite to replace it';
  if (summary.includes('missing_scope')) {
    return 'Enable the missing permission in the Dropbox App Console, then run: agentio dropbox profile add';
  }
  return undefined;
}

export class DropboxClient implements ServiceClient {
  private accessToken: string;

  constructor(credentials: DropboxCredentials) {
    this.accessToken = credentials.accessToken;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const account = await this.account();
      return { valid: true, info: `${account.email} (${account.accountType})` };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async failFromResponse(response: Response, operation: string): Promise<never> {
    const text = await response.text();

    let summary = text;
    try {
      const parsed = JSON.parse(text) as { error_summary?: string };
      if (parsed.error_summary) summary = parsed.error_summary;
    } catch {
      // Dropbox returns plain text for 400 and some 5xx responses
    }

    throw new CliError(
      errorCodeFor(response.status, summary),
      `Dropbox ${operation} failed (${response.status}): ${summary.trim()}`,
      suggestionFor(response.status, summary),
    );
  }

  private async send(url: string, headers: Record<string, string>, body?: BodyInit): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.accessToken}`, ...headers },
        body,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new CliError('NETWORK_ERROR', `Could not reach the Dropbox API: ${message}`);
    }
  }

  /** JSON-in, JSON-out call against api.dropboxapi.com. */
  private async rpc<T>(endpoint: string, args?: unknown): Promise<T> {
    const response = await this.send(
      `${RPC_BASE}/${endpoint}`,
      { 'Content-Type': 'application/json' },
      JSON.stringify(args ?? null),
    );

    if (!response.ok) {
      await this.failFromResponse(response, endpoint);
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Binary-out call against content.dropboxapi.com; metadata rides in a header. */
  private async downloadContent(
    endpoint: string,
    args: unknown,
  ): Promise<{ buffer: Buffer; metadata: RawMetadata | null }> {
    const response = await this.send(`${CONTENT_BASE}/${endpoint}`, {
      'Dropbox-API-Arg': headerSafeJson(args),
    });

    if (!response.ok) {
      await this.failFromResponse(response, endpoint);
    }

    const header = response.headers.get('dropbox-api-result');
    let metadata: RawMetadata | null = null;
    if (header) {
      try {
        metadata = JSON.parse(header) as RawMetadata;
      } catch {
        metadata = null;
      }
    }

    return { buffer: Buffer.from(await response.arrayBuffer()), metadata };
  }

  /** Binary-in call against content.dropboxapi.com. */
  private async uploadContent<T>(endpoint: string, args: unknown, body: Buffer): Promise<T> {
    const response = await this.send(
      `${CONTENT_BASE}/${endpoint}`,
      {
        'Dropbox-API-Arg': headerSafeJson(args),
        'Content-Type': 'application/octet-stream',
      },
      new Uint8Array(body),
    );

    if (!response.ok) {
      await this.failFromResponse(response, endpoint);
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async account(): Promise<DropboxAccount> {
    const raw = await this.rpc<AccountResponse>('users/get_current_account');

    return {
      accountId: raw.account_id,
      name: raw.name?.display_name || '',
      email: raw.email,
      emailVerified: raw.email_verified ?? false,
      accountType: raw.account_type?.['.tag'] || 'unknown',
      country: raw.country,
    };
  }

  async list(options: DropboxListOptions = {}): Promise<DropboxEntry[]> {
    const limit = options.limit ?? 100;
    const keep = (entry: DropboxEntry): boolean =>
      !options.foldersOnly || entry.type === 'folder';

    let page = await this.rpc<ListFolderResponse>('files/list_folder', {
      path: normalizeDropboxPath(options.path),
      recursive: options.recursive ?? false,
      limit: Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
      include_deleted: false,
      include_non_downloadable_files: true,
    });

    const entries = page.entries.map(mapEntry).filter(keep);

    for (let i = 0; page.has_more && entries.length < limit && i < MAX_PAGES; i++) {
      page = await this.rpc<ListFolderResponse>('files/list_folder/continue', {
        cursor: page.cursor,
      });
      entries.push(...page.entries.map(mapEntry).filter(keep));
    }

    return entries.slice(0, limit);
  }

  async get(path: string): Promise<DropboxEntry> {
    const raw = await this.rpc<RawMetadata>('files/get_metadata', {
      path: normalizeDropboxPath(path),
    });
    return mapEntry(raw);
  }

  async search(options: DropboxSearchOptions): Promise<DropboxEntry[]> {
    const limit = options.limit ?? 20;

    const response = await this.rpc<SearchResponse>('files/search_v2', {
      query: options.query,
      options: {
        path: normalizeDropboxPath(options.path),
        max_results: Math.min(Math.max(limit, 1), 1000),
        filename_only: options.filenameOnly ?? false,
      },
    });

    return response.matches
      .map((match) => match.metadata?.metadata)
      .filter((raw): raw is RawMetadata => Boolean(raw))
      .map(mapEntry);
  }

  /**
   * Files are written as-is; folders come back as a zip archive, which is the
   * only way the API hands over a whole tree in one call.
   */
  async download(path: string, outputPath?: string): Promise<DropboxDownloadResult> {
    const remotePath = normalizeDropboxPath(path);

    if (remotePath === '') {
      throw new CliError(
        'INVALID_PARAMS',
        'Cannot download the account root',
        'Give a path, e.g. agentio dropbox download /Documents',
      );
    }

    const entry = await this.get(remotePath);
    const isFolder = entry.type === 'folder';
    const target = outputPath || (isFolder ? `${entry.name}.zip` : entry.name);

    const { buffer } = isFolder
      ? await this.downloadContent('files/download_zip', { path: remotePath })
      : await this.downloadContent('files/download', { path: remotePath });

    await writeFile(target, buffer);

    return {
      path: entry.path,
      outputPath: target,
      size: buffer.length,
      kind: isFolder ? 'folder' : 'file',
    };
  }

  async upload(options: DropboxUploadOptions): Promise<DropboxUploadResult> {
    const { filePath, destination, overwrite } = options;

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(filePath);
    } catch {
      throw new CliError('NOT_FOUND', `Local file not found: ${filePath}`);
    }

    if (stats.isDirectory()) {
      throw new CliError(
        'INVALID_PARAMS',
        `"${filePath}" is a directory`,
        'Upload files one at a time; the API has no recursive upload',
      );
    }

    // A destination ending in "/" (or the root) means "keep the local name"
    const normalizedDestination = normalizeDropboxPath(destination);
    const endsInSlash = (destination ?? '').trim().endsWith('/');
    const remotePath =
      normalizedDestination === '' || endsInSlash
        ? `${normalizedDestination}/${basename(filePath)}`
        : normalizedDestination;

    const commit = {
      path: remotePath,
      mode: overwrite ? 'overwrite' : 'add',
      autorename: false,
      mute: false,
    };

    const raw =
      stats.size > SINGLE_UPLOAD_LIMIT
        ? await this.uploadSession(filePath, stats.size, commit)
        : await this.uploadContent<RawMetadata>(
            'files/upload',
            commit,
            await readFile(filePath),
          );

    return {
      id: raw.id || '',
      name: raw.name || basename(remotePath),
      path: raw.path_display || remotePath,
      size: raw.size ?? stats.size,
      rev: raw.rev,
    };
  }

  /** Chunked upload for files above the 150 MB single-request ceiling. */
  private async uploadSession(
    filePath: string,
    size: number,
    commit: Record<string, unknown>,
  ): Promise<RawMetadata> {
    const handle = await open(filePath, 'r');

    try {
      const chunk = Buffer.alloc(UPLOAD_CHUNK_SIZE);
      let offset = 0;

      const readChunk = async (): Promise<Buffer> => {
        const { bytesRead } = await handle.read(chunk, 0, UPLOAD_CHUNK_SIZE, offset);
        return chunk.subarray(0, bytesRead);
      };

      const firstChunk = await readChunk();
      const { session_id: sessionId } = await this.uploadContent<{ session_id: string }>(
        'files/upload_session/start',
        { close: false },
        firstChunk,
      );
      offset = firstChunk.length;

      while (offset < size) {
        const body = await readChunk();
        await this.uploadContent<void>(
          'files/upload_session/append_v2',
          { cursor: { session_id: sessionId, offset }, close: false },
          body,
        );
        offset += body.length;
      }

      return await this.uploadContent<RawMetadata>(
        'files/upload_session/finish',
        { cursor: { session_id: sessionId, offset }, commit },
        Buffer.alloc(0),
      );
    } finally {
      await handle.close();
    }
  }

  async mkdir(path: string): Promise<DropboxEntry> {
    const response = await this.rpc<{ metadata: RawMetadata }>('files/create_folder_v2', {
      path: normalizeDropboxPath(path),
      autorename: false,
    });
    return mapEntry({ ...response.metadata, '.tag': 'folder' });
  }

  async move(from: string, to: string): Promise<DropboxEntry> {
    const response = await this.rpc<{ metadata: RawMetadata }>('files/move_v2', {
      from_path: normalizeDropboxPath(from),
      to_path: normalizeDropboxPath(to),
      autorename: false,
    });
    return mapEntry(response.metadata);
  }

  async copy(from: string, to: string): Promise<DropboxEntry> {
    const response = await this.rpc<{ metadata: RawMetadata }>('files/copy_v2', {
      from_path: normalizeDropboxPath(from),
      to_path: normalizeDropboxPath(to),
      autorename: false,
    });
    return mapEntry(response.metadata);
  }

  /** Moves to the Dropbox trash, where it stays recoverable. */
  async delete(path: string): Promise<DropboxEntry> {
    const response = await this.rpc<{ metadata: RawMetadata }>('files/delete_v2', {
      path: normalizeDropboxPath(path),
    });
    return mapEntry(response.metadata);
  }

  /** Direct download URL that expires after four hours. Files only. */
  async temporaryLink(path: string): Promise<DropboxLink> {
    const response = await this.rpc<{ link: string; metadata: RawMetadata }>(
      'files/get_temporary_link',
      { path: normalizeDropboxPath(path) },
    );

    return {
      url: response.link,
      path: response.metadata.path_display || normalizeDropboxPath(path),
      kind: 'temporary',
    };
  }

  /**
   * Dropbox refuses to create a second shared link for the same path, so an
   * existing link is looked up and returned instead of surfacing that error.
   */
  async sharedLink(path: string): Promise<DropboxLink> {
    const remotePath = normalizeDropboxPath(path);

    try {
      const response = await this.rpc<{ url: string }>('sharing/create_shared_link_with_settings', {
        path: remotePath,
      });
      return { url: response.url, path: remotePath, kind: 'shared' };
    } catch (error) {
      if (!(error instanceof CliError) || !error.message.includes('shared_link_already_exists')) {
        throw error;
      }

      const existing = await this.rpc<{ links: Array<{ url: string }> }>('sharing/list_shared_links', {
        path: remotePath,
        direct_only: true,
      });

      if (existing.links.length === 0) throw error;
      return { url: existing.links[0].url, path: remotePath, kind: 'shared' };
    }
  }
}
