import { hostname } from 'os';
import { CliError } from '../utils/errors';
import { sleep } from '../utils/batch';
import { validateHubUrl, type ApiKeyView } from './api-keys';
import { hubCall } from './remote';

/**
 * Client side of the hub's device login (`src/daemon/device-auth.ts`): ask
 * for a code, show it, poll until the owner decides. No callback server and
 * no redirect, so it works over SSH and in containers; the token only ever
 * travels in the poll answer.
 */

export interface DeviceLoginOptions {
  /** Hub base URL as the user typed it; only its origin is used, https assumed when no scheme is given. */
  url: string;
  /** Shown to the owner and used as the key's default name. */
  name?: string;
  /** Called once with the code and the page the owner must open. */
  onCode: (info: { userCode: string; verifyUrl: string; expiresIn: number }) => void;
  /** Tests poll faster than the hub asks. */
  pollMs?: number;
}

export interface DeviceLoginResult {
  url: string;
  token: string;
  key: ApiKeyView;
}

/** Origin of the hub URL, or INVALID_PARAMS. */
export function hubOrigin(input: string): string {
  return validateHubUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
}

type Poll = { status: 'pending' } | { status: 'denied' } | { status: 'approved'; token: string; key: ApiKeyView };

const code = (err: unknown) => (err instanceof CliError ? err.code : null);

export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const url = hubOrigin(options.url);
  const name = options.name?.trim() || hostname();

  let start: { userCode: string; deviceCode: string; expiresIn: number; interval: number };
  try {
    start = await hubCall(url, '/v1/device', { method: 'POST', body: { name } });
  } catch (err) {
    // Not a hub at all (404), or a hub too old to have the route, which answers with its bearer check instead.
    if (code(err) === 'NOT_FOUND' || code(err) === 'AUTH_FAILED') {
      throw new CliError('CONFIG_ERROR', `${url} does not offer device login`, 'Is this the hub URL, and is the hub up to date?');
    }
    throw err;
  }
  options.onCode({ userCode: start.userCode, verifyUrl: `${url}/ui#authorize=${start.userCode}`, expiresIn: start.expiresIn });

  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = options.pollMs ?? start.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let answer: Poll;
    try {
      answer = await hubCall<Poll>(url, '/v1/device/token', { method: 'POST', body: { deviceCode: start.deviceCode } });
    } catch (err) {
      if (code(err) === 'NOT_FOUND') break; // the hub forgot it: expired, or restarted
      if (code(err) === 'RATE_LIMITED') { interval *= 2; continue; }
      throw err;
    }
    if (answer.status === 'approved') return { url, token: answer.token, key: answer.key };
    if (answer.status === 'denied') throw new CliError('AUTH_FAILED', 'The hub owner denied this login');
  }
  throw new CliError('AUTH_FAILED', 'The login code expired before it was approved', 'Run `agentio login` again and approve within ten minutes');
}
