import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import type { PagerioCredentials, PagerioPageInput, PagerioSentPage } from './types';

/** A Pocket Pager URL (https://pagerio.chuut.com): POST to it and its owner's iPhone and Mac ring. */

export const PAGERIO_URL = 'https://pagerio.chuut.com';
const REQUEST_TIMEOUT_MS = 30_000;
const TOKEN_PATTERN = /^\/p\/[A-Za-z0-9]{16}$/;
const PROFILE_ADD = 'Copy it with the Copy button on the dashboard (https://pagerio.chuut.com), then run: agentio pagerio profile add';

/** The pager URL in its one canonical form, or INVALID_PARAMS. Plain http only for a local server. */
export function parsePagerUrl(input: string): string {
  const text = input.trim();
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    // Reported below with the same message as any other wrong shape.
  }
  const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const ok = url
    && (url.protocol === 'https:' || (url.protocol === 'http:' && local))
    && !url.username && !url.password && !url.search && !url.hash
    && TOKEN_PATTERN.test(url.pathname);
  if (!ok) {
    throw new CliError('INVALID_PARAMS', 'That is not a pager URL. It looks like https://pagerio.chuut.com/p/ followed by 16 letters and digits', PROFILE_ADD);
  }
  return `${url!.origin}${url!.pathname}`;
}

export class PagerioClient implements ServiceClient {
  private readonly url: string;

  constructor(credentials: PagerioCredentials) {
    this.url = credentials.url;
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.check();
      return { valid: true, info: new URL(this.url).host };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Checks that the server knows this URL, without paging anyone. The server looks the URL up before it reads
   * the body, so a body that is not valid JSON answers 400 for a known URL and 404 for an unknown one.
   * (GET can't tell: it returns the same guide for every URL.)
   */
  async check(): Promise<void> {
    const response = await this.post('{', { 'Content-Type': 'application/json' });
    if (response.status === 400) return;
    throw this.errorFor(response.status, await this.readJson(response));
  }

  async send(input: PagerioPageInput, idempotencyKey?: string): Promise<PagerioSentPage> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const response = await this.post(JSON.stringify(input), headers);
    const data = await this.readJson(response);
    if (!response.ok) throw this.errorFor(response.status, data);
    const page = data as Partial<PagerioSentPage> | null;
    if (!page || typeof page.id !== 'string' || typeof page.view_url !== 'string') {
      throw new CliError('API_ERROR', 'Pocket Pager accepted the page but its answer could not be read');
    }
    return page as PagerioSentPage;
  }

  private async post(body: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: { Accept: 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The host only: the full URL is the secret.
      throw new CliError('NETWORK_ERROR', `Cannot reach Pocket Pager at ${new URL(this.url).host}`, 'Check your network and retry');
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '');
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null; // Not JSON, such as a proxy's error page: the status alone decides.
    }
  }

  /** The CLI error for a failed answer, from the server's `{ error: { code, message } }` body. */
  private errorFor(status: number, data: unknown): CliError {
    const error = data && typeof data === 'object' ? (data as { error?: { message?: unknown } }).error : undefined;
    const detail = typeof error?.message === 'string' && error.message.trim() ? this.clean(error.message.trim()) : undefined;
    switch (status) {
      case 400:
      case 413:
        return new CliError('INVALID_PARAMS', `Pocket Pager refused the page: ${detail ?? 'invalid request'}`);
      case 404:
        return new CliError('NOT_FOUND', 'Pocket Pager does not know this pager URL', PROFILE_ADD);
      case 429:
        return new CliError('RATE_LIMITED', `Pocket Pager: ${detail ?? 'too many pages'}`, 'Wait a minute, then send again');
    }
    return new CliError('API_ERROR', detail ? `Pocket Pager error: ${detail}` : `Pocket Pager answered ${status}`);
  }

  /** A server message fit to show: never the pager URL or its token. */
  private clean(message: string): string {
    const token = this.url.slice(this.url.lastIndexOf('/') + 1);
    return message.split(this.url).join('[pager url]').split(token).join('[token]');
  }
}
