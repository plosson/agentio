import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';
import type {
  PocketAlertApplication,
  PocketAlertCredentials,
  PocketAlertMessage,
  PocketAlertMessageInput,
} from './types';

/** The Pocket Alert REST API (https://info.pocketalert.app/api/). */

export const POCKETALERT_API_URL = 'https://api.pocketalert.app/v1';
const REQUEST_TIMEOUT_MS = 30_000;

export class PocketAlertClient implements ServiceClient {
  private readonly apiKey: string;

  constructor(credentials: PocketAlertCredentials) {
    this.apiKey = credentials.apiKey;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const applications = await this.applications();
      return { valid: true, info: `${applications.length} application${applications.length === 1 ? '' : 's'}` };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', Token: this.apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${POCKETALERT_API_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CliError('NETWORK_ERROR', 'Cannot reach Pocket Alert at api.pocketalert.app', 'Check your network and retry');
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
      if (data === null) throw new CliError('API_ERROR', 'Pocket Alert did not answer with JSON');
      return data as T;
    }
    throw this.errorFor(response.status, data);
  }

  /** The CLI error for a failed answer, from the server's `{ error }` body. */
  private errorFor(status: number, data: unknown): CliError {
    const raw = data && typeof data === 'object' ? (data as { error?: unknown; message?: unknown }) : {};
    const detail = [raw.error, raw.message].find((v): v is string => typeof v === 'string' && v.trim() !== '');
    const message = detail ? this.clean(detail.trim()) : undefined;
    switch (status) {
      case 401:
      case 403:
        return new CliError('AUTH_FAILED', 'Pocket Alert refused the API key',
          'Copy the key from Settings in the Pocket Alert app, then run: agentio pocketalert profile add');
      case 400:
      case 422:
        return new CliError('INVALID_PARAMS', `Pocket Alert refused the message: ${message ?? 'invalid request'}`);
      case 429:
        return new CliError('QUOTA_EXCEEDED', 'Pocket Alert\'s daily message limit is reached',
          'Messages are accepted again from 00:00 UTC');
    }
    // An unknown device or application comes back as a 500 ("Device not found", "record not found").
    if (message && /not found/i.test(message)) {
      return new CliError('NOT_FOUND', `Pocket Alert: ${message}`,
        'Check the --application and --device ids in the Pocket Alert app');
    }
    return new CliError('API_ERROR', message ? `Pocket Alert error: ${message}` : `Pocket Alert answered ${status}`);
  }

  /** A server message fit to show: never the API key. */
  private clean(message: string): string {
    return this.apiKey ? message.split(this.apiKey).join('[api key]') : message;
  }

  /** `GET /v1/applications`: changes nothing, so setup checks the key with it. */
  async applications(): Promise<PocketAlertApplication[]> {
    const data = await this.request<unknown>('GET', '/applications');
    return Array.isArray(data) ? (data as PocketAlertApplication[]) : [];
  }

  async send(input: PocketAlertMessageInput): Promise<PocketAlertMessage> {
    if (!input.title.trim()) throw new CliError('INVALID_PARAMS', 'A message needs a title', 'Pass --title');
    if (!input.message.trim()) throw new CliError('INVALID_PARAMS', 'A message needs a body', 'Pass --message');
    return this.request<PocketAlertMessage>('POST', '/messages', input);
  }
}

/** A `--level` value: a whole number from -2 to 2, or a level name the server knows. */
export function parseLevel(input: string): string | number {
  const value = input.trim();
  if (!value) throw new CliError('INVALID_PARAMS', '--level cannot be empty');
  if (/^[+-]?\d+$/.test(value)) {
    const n = Number(value);
    if (n < -2 || n > 2) throw new CliError('INVALID_PARAMS', `--level must be from -2 to 2, not ${value}`);
    return n;
  }
  return value;
}
