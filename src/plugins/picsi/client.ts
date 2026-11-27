import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError, httpStatusToErrorCode, redact } from '../../utils/errors';
import type { PicsiAccount, PicsiCredentials, PicsiImage, PicsiResponse, PicsiSwapResult } from './types';

export const PICSI_URL = 'https://www.picsi.ai';
const SIGN_IN = 'Run: agentio picsi profile add (or agentio profile reauth picsi)';

export function parseSessionToken(input: unknown): string {
  if (typeof input !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(input.trim())) {
    throw new CliError('INVALID_PARAMS', 'A Picsi session token must be non-empty text without spaces or line breaks', 'Use your Picsi session token, not your Discord token');
  }
  return input.trim();
}

interface ClientOptions {
  /** Test seam; production always uses Picsi's own website. */
  baseUrl?: string;
  fetch?: typeof fetch;
  pollMs?: number;
  waitMs?: number;
  requestTimeoutMs?: number;
}

function numeric(value: unknown): number | undefined {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** Only public fields leave the client; the service may include a token in userInfo. */
function accountView(data: Record<string, unknown>): PicsiAccount {
  if ((typeof data.uid !== 'string' && typeof data.uid !== 'number') || !String(data.uid)) {
    throw new CliError('AUTH_FAILED', 'Picsi did not recognise the session', SIGN_IN);
  }
  return {
    id: String(data.uid),
    name: typeof data.name === 'string' ? data.name : String(data.uid),
    ...(typeof data.email === 'string' ? { email: data.email } : {}),
    plan: typeof data.role === 'string' ? data.role : 'Unknown',
    creditsRemaining: numeric(data.creditsRemain) ?? 0,
    creditsTotal: numeric(data.creditsAll) ?? 0,
  };
}

/** Internal web protocol observed in the official Chrome extension v1.0.3; no Discord requests. */
export class PicsiClient implements ServiceClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly transport: typeof fetch;
  private readonly pollMs: number;
  private readonly waitMs: number;
  private readonly requestTimeoutMs: number;

  constructor(credentials: PicsiCredentials, options: ClientOptions = {}) {
    this.token = parseSessionToken(credentials.token);
    this.baseUrl = options.baseUrl ?? PICSI_URL;
    this.transport = options.fetch ?? fetch;
    this.pollMs = options.pollMs ?? 10_000;
    this.waitMs = options.waitMs ?? 180_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180_000;
  }

  private async request(path: string, body?: FormData | Record<string, unknown>, extraSecrets: string[] = []): Promise<PicsiResponse> {
    const headers: Record<string, string> = { uk: this.token };
    const isForm = body instanceof FormData;
    if (body && !isForm) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.transport(this.baseUrl + path, {
        method: body ? 'POST' : 'GET', headers,
        body: isForm ? body : body ? JSON.stringify(body) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new CliError('NETWORK_ERROR', 'Could not complete the request to Picsi', body instanceof FormData ? 'The swap may have reached Picsi. Check your account before submitting again' : 'Check your connection and try again');
    }
    let value: PicsiResponse;
    try { value = await response.json() as PicsiResponse; }
    catch { throw new CliError('API_ERROR', `Picsi returned an unreadable response (HTTP ${response.status})`); }
    if (!value || typeof value.code !== 'number') throw new CliError('API_ERROR', 'Picsi returned an unexpected response');
    if (!response.ok || (value.code !== 0 && value.code !== 9031)) {
      const auth = response.status === 401 || value.code === 90401;
      const message = typeof value.message === 'string' ? redact(value.message, [this.token, ...extraSecrets], '[redacted]') : `Request failed (HTTP ${response.status}, code ${value.code})`;
      throw new CliError(auth ? 'AUTH_FAILED' : httpStatusToErrorCode(response.status), `Picsi: ${message}`, auth ? SIGN_IN : undefined);
    }
    return value;
  }

  async account(): Promise<PicsiAccount> {
    const response = await this.request('/user/info');
    return accountView(response.data ?? {});
  }

  async validate(): Promise<ValidationResult> {
    try {
      const account = await this.account();
      return { valid: true, info: `${account.name} (${account.plan}), ${account.creditsRemaining}/${account.creditsTotal} credits` };
    } catch (error) {
      return { valid: false, error: error instanceof CliError ? error.message : 'Could not validate the Picsi session' };
    }
  }

  async swap(source: PicsiImage, target: PicsiImage, settings: Record<string, string>, log: (line: string) => void): Promise<PicsiSwapResult> {
    const started = Date.now();
    let count = 0;
    let ticket: Record<string, unknown> | undefined;
    while (Date.now() - started < this.waitMs) {
      const response = await this.request('/api/morph/token', { count: ++count, time: started });
      if (response.code === 0) { ticket = response.data; break; }
      log('Waiting for a Picsi processing slot…');
      await Bun.sleep(Math.min(this.pollMs, Math.max(0, this.waitMs - (Date.now() - started))));
    }
    if (!ticket) throw new CliError('RATE_LIMITED', 'Picsi did not provide a processing slot in time', 'Try the swap again later');
    if (typeof ticket.token !== 'string' || !ticket.token || numeric(ticket.time) === undefined || numeric(ticket.count) === undefined) {
      throw new CliError('API_ERROR', 'Picsi returned an incomplete processing token');
    }
    const form = new FormData();
    for (const [key, value] of Object.entries(settings)) form.append(key, value);
    form.append('source_0', source.blob, source.name);
    form.append('target', target.blob, target.name);
    form.append('token', ticket.token);
    form.append('d_ts', String(ticket.time));
    form.append('d_te', String(Date.now()));
    form.append('d_tc', String(ticket.count));
    log('Swapping the selected face…');
    // Never retry a submission: the service has no documented idempotency mechanism.
    const response = await this.request('/api/morph/image', form, [ticket.token]);
    if (response.code !== 0 || typeof response.data?.output !== 'string' || !response.data.output) {
      throw new CliError('API_ERROR', 'Picsi did not return a swapped image');
    }
    const user = response.data.userInfo as Record<string, unknown> | undefined;
    return {
      output: response.data.output,
      ...(user && numeric(user.creditsRemain) !== undefined ? { creditsRemaining: numeric(user.creditsRemain) } : {}),
      ...(user && numeric(user.creditsAll) !== undefined ? { creditsTotal: numeric(user.creditsAll) } : {}),
    };
  }
}
