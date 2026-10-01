import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import type { TodoCredentials, TodoItem, TodoMe, TodoTag } from './types';

const REAUTH = 'Run: agentio profile reauth todo';
const REQUEST_TIMEOUT_MS = 30_000;

interface ErrorEnvelope {
  error?: string;
  message?: string;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  auth?: boolean;
}

interface RawResponse {
  status: number;
  headers: Headers;
  data: unknown;
}

/** Scheme required (https added when absent), http(s) only, no path, no trailing slash. */
export function normaliseBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new CliError('INVALID_PARAMS', 'The Todo URL is required', 'Example: --url https://todo.example.com');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError('INVALID_PARAMS', `Not a valid Todo URL: ${input}`, 'Example: --url https://todo.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('INVALID_PARAMS', `A Todo URL must use https or http, not ${url.protocol.slice(0, -1)}`);
  }
  if (!url.hostname || url.username || url.password) {
    throw new CliError('INVALID_PARAMS', `Not a valid Todo URL: ${input}`, 'Example: --url https://todo.example.com');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export class TodoClient implements ServiceClient {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(credentials: Pick<TodoCredentials, 'baseUrl' | 'token'>) {
    this.baseUrl = credentials.baseUrl.replace(/\/+$/, '');
    this.token = credentials.token;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const me = await this.me();
      return { valid: true, info: me.email };
    } catch (error) {
      if (error instanceof CliError && error.code === 'AUTH_EXPIRED') {
        return { valid: false, error: `${error.message}. ${REAUTH}` };
      }
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async raw(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CliError('NETWORK_ERROR', `Cannot reach Todo at ${this.baseUrl}`, 'Check the URL and your network connection');
    }
    const text = await response.text().catch(() => '');
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // ignore
      }
    }
    return { status: response.status, headers: response.headers, data };
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.raw(method, path, options);
    if (res.status >= 200 && res.status < 300) return res.data as T;
    throw this.errorFor(res);
  }

  errorFor(res: RawResponse): CliError {
    const body = res.data as ErrorEnvelope | null;
    const detail = typeof body?.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
    const withDetail = (message: string) => (detail && detail !== message ? `${message}: ${detail}` : message);

    if (res.status === 401 || body?.error === 'unauthenticated') {
      return new CliError('AUTH_EXPIRED', `Todo at ${this.baseUrl} no longer accepts this sign-in`, REAUTH);
    }
    if (res.status === 403 || body?.error === 'forbidden') {
      return new CliError('PERMISSION_DENIED', withDetail('Todo refused this action'));
    }
    if (res.status === 404 || body?.error === 'not_found') {
      return new CliError('NOT_FOUND', withDetail('Not found on Todo'), 'Check the id');
    }
    if (res.status === 400 || body?.error === 'validation_failed') {
      return new CliError('INVALID_PARAMS', withDetail('Invalid request'));
    }
    return new CliError('API_ERROR', withDetail(`Todo returned HTTP ${res.status}`), 'Try again; if it keeps failing, check the server');
  }

  me(): Promise<TodoMe> {
    return this.request('GET', '/api/auth/me');
  }

  list(opts: { tag?: string; status?: 'open' | 'done' | 'all' } = {}): Promise<TodoItem[]> {
    return this.request<{ todos: TodoItem[] }>('GET', '/api/todos', {
      query: { tag: opts.tag, status: opts.status ?? 'open' },
    }).then((r) => r.todos);
  }

  get(id: string): Promise<TodoItem> {
    return this.request('GET', `/api/todos/${encodeURIComponent(id)}`);
  }

  create(input: { title: string; tags?: string[]; notes?: string }): Promise<TodoItem> {
    return this.request('POST', '/api/todos', { body: input });
  }

  check(id: string): Promise<TodoItem> {
    return this.request('POST', `/api/todos/${encodeURIComponent(id)}/check`);
  }

  uncheck(id: string): Promise<TodoItem> {
    return this.request('POST', `/api/todos/${encodeURIComponent(id)}/uncheck`);
  }

  remove(id: string): Promise<void> {
    return this.request('DELETE', `/api/todos/${encodeURIComponent(id)}`).then(() => undefined);
  }

  listTags(): Promise<TodoTag[]> {
    return this.request<{ tags: TodoTag[] }>('GET', '/api/tags').then((r) => r.tags);
  }
}
