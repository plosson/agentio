import { hostname } from 'os';
import { CliError } from '../utils/errors';
import { sleep } from '../utils/batch';
import { validateHubUrl, type ApiKeyView } from './api-keys';
import { hubCall } from './remote';
import { decodeToken } from './token';
import type { Scope } from './scopes';

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
  /** Access to ask for; the owner approves all of it or nothing. Already validated (`validateScopes`). */
  scopes?: Scope[];
  /** This machine's stored token; sent only to the hub it belongs to, whose key the new one replaces. */
  currentToken?: string | null;
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

/** The stored token when it belongs to `hubUrl` (an origin), so a new login there replaces its key; else undefined. */
export function replacementToken(token: string | null | undefined, hubUrl: string): string | undefined {
  if (!token) return undefined;
  try {
    return hubOrigin(decodeToken(token).url) === hubUrl ? token : undefined;
  } catch {
    return undefined;
  }
}

/** A hub older than scopes ignores them and still answers; it must not get a request it would show as a plain login. */
const noScopeSupport = (url: string) =>
  new CliError('CONFIG_ERROR', `The hub at ${url} does not support access requests`, 'Update the hub to agentio 3.14 or later');

/** A login that ended without a token: the owner said no, or nobody decided in time. */
export class LoginNotApproved extends CliError {
  constructor(public readonly outcome: 'denied' | 'expired', message: string, suggestion?: string) {
    super('AUTH_FAILED', message, suggestion);
    this.name = 'LoginNotApproved';
  }
}

type Poll = { status: 'pending' } | { status: 'denied' } | { status: 'approved'; token: string; key: ApiKeyView };

const code = (err: unknown) => (err instanceof CliError ? err.code : null);

export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const url = hubOrigin(options.url);
  const chosenName = options.name?.trim();
  const replaces = replacementToken(options.currentToken, url);
  const body = {
    name: chosenName || hostname(),
    nameIsDefault: !chosenName,
    ...(options.scopes && { scopes: options.scopes }),
    ...(replaces && { replaces }),
  };

  const notAHub = () =>
    new CliError('CONFIG_ERROR', `${url} does not offer device login`, 'Is this the hub URL, and is the hub up to date?');
  let start: { userCode: string; deviceCode: string; expiresIn: number; interval: number; scopes?: unknown } | null;
  try {
    start = await hubCall(url, '/v1/device', { method: 'POST', body });
  } catch (err) {
    // Not a hub at all (404), or a hub too old to have the route, which answers with its bearer check instead.
    if (code(err) === 'NOT_FOUND' || code(err) === 'AUTH_FAILED') throw notAHub();
    throw err;
  }
  // A landing page or SPA answers 200 with HTML, which parses to null.
  if (!start || typeof start.userCode !== 'string' || typeof start.deviceCode !== 'string') throw notAHub();
  if (options.scopes && JSON.stringify(start.scopes) !== JSON.stringify(options.scopes)) throw noScopeSupport(url);
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
    if (answer.status === 'denied') throw new LoginNotApproved('denied', 'The hub owner denied this login');
  }
  throw new LoginNotApproved('expired', 'The login code expired before it was approved', 'Run `agentio login` again and approve within ten minutes');
}
