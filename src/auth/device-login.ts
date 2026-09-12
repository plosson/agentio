import { hostname } from 'os';
import { CliError } from '../utils/errors';
import type { ApiKeyView } from './api-keys';

/**
 * Client side of the hub's device login (`src/daemon/device-auth.ts`): ask
 * for a code, show it, poll until the owner decides. No callback server and
 * no redirect, so it works over SSH and in containers; the token only ever
 * travels in the poll answer.
 */

export interface DeviceLoginOptions {
  /** Hub base URL as the user typed it; only its origin is used. */
  url: string;
  /** Shown to the owner and used as the key's default name. */
  name?: string;
  /** Called once with the code and the page the owner must open. */
  onCode: (info: { userCode: string; verifyUrl: string; expiresIn: number }) => void;
  /** Tests override the hub's interval; production honours what the hub says. */
  pollMs?: number;
}

export interface DeviceLoginResult {
  url: string;
  token: string;
  key: ApiKeyView;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Origin of the hub URL, or INVALID_PARAMS. */
export function hubOrigin(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new CliError('INVALID_PARAMS', `Not a valid hub URL: ${input}`, 'Pass the hub as https://vault.example.com');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CliError('INVALID_PARAMS', 'The hub URL must use http or https');
  }
  return parsed.origin;
}

async function post<T>(url: string, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CliError('NETWORK_ERROR', `Cannot reach the vault hub at ${url}: ${reason}`, 'Check the URL, the network, and that the hub daemon is running');
  }
  const text = await response.text();
  let parsed: { error?: string; suggestion?: string } | null = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) {
    if (response.status === 404 && path === '/v1/device') {
      throw new CliError('CONFIG_ERROR', `${url} does not offer device login`, 'Is this the hub URL, and is the hub up to date?');
    }
    throw new CliError(response.status === 429 ? 'RATE_LIMITED' : 'API_ERROR', parsed?.error ?? `HTTP ${response.status}`, parsed?.suggestion);
  }
  return parsed as T;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Poll =
  | { status: 'pending'; interval: number }
  | { status: 'denied' }
  | { status: 'approved'; token: string; key: ApiKeyView };

export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const url = hubOrigin(options.url);
  const name = options.name?.trim() || hostname();
  const start = await post<{ userCode: string; deviceCode: string; expiresIn: number; interval: number }>(url, '/v1/device', { name });
  options.onCode({ userCode: start.userCode, verifyUrl: `${url}/ui#authorize=${start.userCode}`, expiresIn: start.expiresIn });

  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = options.pollMs ?? start.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let answer: Poll;
    try {
      answer = await post<Poll>(url, '/v1/device/token', { deviceCode: start.deviceCode });
    } catch (err) {
      // 404 is the hub saying the request is gone: expired, or it restarted.
      if (err instanceof CliError && err.code === 'API_ERROR' && /expired/i.test(err.message)) break;
      if (err instanceof CliError && err.code === 'RATE_LIMITED') { interval *= 2; continue; }
      throw err;
    }
    if (answer.status === 'approved') return { url, token: answer.token, key: answer.key };
    if (answer.status === 'denied') throw new CliError('AUTH_FAILED', 'The hub owner denied this login');
    if (options.pollMs === undefined) interval = answer.interval * 1000;
  }
  throw new CliError('AUTH_FAILED', 'The login code expired before it was approved', 'Run `agentio login` again and approve within ten minutes');
}
