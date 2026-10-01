import { marked } from 'marked';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { normaliseServerUrl } from '../../utils/base-url';
import { CliError } from '../../utils/errors';
import type {
  Note,
  NoteBodyFormat,
  NoteInput,
  NotesCredentials,
  NotesFolder,
  NotesHealth,
  NotesListOptions,
  NoteSummary,
} from './types';

/**
 * The REST API of apple-notes-api (https://github.com/plosson/apple-notes-api),
 * a server that runs next to Notes.app on a Mac and drives it with AppleScript.
 */

const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_LIST_LIMIT = 1000;

interface ErrorBody {
  error?: string;
  message?: string;
  detail?: string;
  issues?: { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
}

export function normaliseNotesUrl(input: string): string {
  return normaliseServerUrl(input, 'Notes server', 'https://mac-mini.example.ts.net');
}

/** A `--limit` value: a whole number from 1 to 1000. */
export function parseLimit(input: string): number {
  const n = Number(input);
  if (!/^\d+$/.test(input.trim()) || !Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
    throw new CliError('INVALID_PARAMS', `--limit must be a whole number from 1 to ${MAX_LIST_LIMIT}, not "${input}"`);
  }
  return n;
}

/** A note id as the server gives it, refused when empty. */
function requireNoteId(input: string): string {
  const id = input.trim();
  if (!id) throw new CliError('INVALID_PARAMS', 'A note id is required', 'Note ids look like x-coredata://…; see: agentio notes list');
  return id;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A body as Notes stores it. Every format is sent as HTML so the server never
 * has to guess: Markdown is rendered, text is escaped one line per block.
 */
export function bodyToHtml(body: string, format: NoteBodyFormat): string {
  switch (format) {
    case 'html':
      return body;
    case 'text':
      return body
        .split(/\r?\n/)
        .map((line) => (line ? `<div>${escapeHtml(line)}</div>` : '<div><br></div>'))
        .join('');
    case 'markdown':
      return (marked.parse(body, { async: false }) as string).trim();
  }
}

export class NotesClient implements ServiceClient {
  readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(credentials: NotesCredentials) {
    this.baseUrl = credentials.baseUrl.replace(/\/+$/, '');
    this.apiKey = credentials.apiKey;
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.folders();
      return { valid: true, info: this.baseUrl };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private async request<T>(method: string, path: string, options: { body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.auth !== false) headers.Authorization = `Bearer ${this.apiKey}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CliError('NETWORK_ERROR', `Cannot reach the Notes server at ${this.baseUrl}`,
        'Check the URL, your network or Tailscale, and that the server is running on the Mac');
    }
    const text = await response.text().catch(() => '');
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Not JSON, such as a proxy's error page: the status alone decides.
      }
    }
    if (response.ok) {
      if (data === null) throw new CliError('API_ERROR', `The Notes server at ${this.baseUrl} did not answer with JSON`);
      return data as T;
    }
    throw this.errorFor(response.status, (data ?? {}) as ErrorBody);
  }

  /** The CLI error for a failed answer, from the server's `{ error, message }` body. */
  private errorFor(status: number, body: ErrorBody): CliError {
    const message = typeof body.message === 'string' && body.message.trim() ? this.clean(body.message.trim()) : undefined;
    switch (body.error) {
      case 'Unauthorized':
        return new CliError('AUTH_FAILED', `The Notes server at ${this.baseUrl} refused the API key`,
          'Check NOTES_API_KEY on the Mac, then run: agentio notes profile add');
      case 'PermissionDenied':
        return new CliError('PERMISSION_DENIED', 'macOS does not let the Notes server control Notes.app',
          'On the Mac: System Settings > Privacy & Security > Automation, allow the server to control Notes');
      case 'LockedNote':
        return new CliError('PERMISSION_DENIED', 'This note is locked with a password and cannot be read or changed');
      case 'NotFound':
        return new CliError('NOT_FOUND', message ?? 'Not found',
          'List note ids with: agentio notes list, and folder names with: agentio notes folders');
      case 'ValidationError':
        return new CliError('INVALID_PARAMS', `The Notes server refused the request: ${describeIssues(body.issues)}`);
      case 'PlatformUnsupported':
        return new CliError('CONFIG_ERROR', 'The Notes server is not running on macOS, so it cannot reach Notes.app',
          'Run apple-notes-api on the Mac that has Notes');
    }
    if (status === 401) {
      return new CliError('AUTH_FAILED', `The Notes server at ${this.baseUrl} refused the API key`,
        'Check NOTES_API_KEY on the Mac, then run: agentio notes profile add');
    }
    if (status === 404) {
      return new CliError('NOT_FOUND', message ?? `No Notes API at ${this.baseUrl}`, 'Check the profile URL');
    }
    return new CliError('API_ERROR', message ? `Notes server error: ${message}` : `The Notes server answered ${status}`,
      body.error === 'NotesError' ? 'Notes.app may be busy or waiting on a permission prompt on the Mac; retry' : undefined);
  }

  /** A server message fit to show: never the API key. */
  private clean(message: string): string {
    return this.apiKey ? message.split(this.apiKey).join('[api key]') : message;
  }

  /** `GET /health`, which needs no key: is this an apple-notes-api server? */
  async health(): Promise<NotesHealth> {
    const data = await this.request<Partial<NotesHealth>>('GET', '/health', { auth: false });
    if (data.ok !== true || typeof data.platform !== 'string') {
      throw new CliError('CONFIG_ERROR', `${this.baseUrl} does not look like an apple-notes-api server`, 'Check the URL');
    }
    return { ok: true, version: String(data.version ?? 'unknown'), platform: data.platform };
  }

  async folders(): Promise<NotesFolder[]> {
    const data = await this.request<{ folders?: NotesFolder[] }>('GET', '/v1/folders');
    return data.folders ?? [];
  }

  async list(options: NotesListOptions = {}): Promise<NoteSummary[]> {
    const params = new URLSearchParams();
    if (options.folder) params.set('folder', options.folder);
    if (options.query) params.set('q', options.query);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const qs = params.toString();
    const data = await this.request<{ notes?: NoteSummary[] }>('GET', `/v1/notes${qs ? `?${qs}` : ''}`);
    return data.notes ?? [];
  }

  async get(id: string): Promise<Note> {
    const data = await this.request<{ note: Note }>('GET', notePath(id));
    return data.note;
  }

  async create(input: Required<Pick<NoteInput, 'name' | 'body'>> & Pick<NoteInput, 'folder'>): Promise<Note> {
    if (!input.name.trim()) throw new CliError('INVALID_PARAMS', 'A note needs a title', 'Pass --title');
    const data = await this.request<{ note: Note }>('POST', '/v1/notes', { body: input });
    return data.note;
  }

  async update(id: string, input: NoteInput): Promise<Note> {
    if (input.name === undefined && input.body === undefined && input.folder === undefined) {
      throw new CliError('INVALID_PARAMS', 'Nothing to update', 'Pass --title, --body, --file or --folder');
    }
    if (input.name !== undefined && !input.name.trim()) {
      throw new CliError('INVALID_PARAMS', 'A note title cannot be empty');
    }
    const data = await this.request<{ note: Note }>('PATCH', notePath(id), { body: input });
    return data.note;
  }

  async delete(id: string): Promise<{ id: string }> {
    const data = await this.request<{ id?: string }>('DELETE', notePath(id));
    return { id: data.id ?? id.trim() };
  }
}

/** Ids are `x-coredata://…` URLs, so they go in the path encoded. */
function notePath(id: string): string {
  return `/v1/notes/${encodeURIComponent(requireNoteId(id))}`;
}

function describeIssues(issues: ErrorBody['issues']): string {
  const parts = [
    ...(issues?.formErrors ?? []),
    ...Object.entries(issues?.fieldErrors ?? {}).map(([field, errors]) => `${field}: ${(errors ?? []).join(', ')}`),
  ];
  return parts.length ? parts.join('; ') : 'invalid request';
}
