import { hostname } from 'os';
import { CliError } from '../../utils/errors';
import { sleep as realSleep } from '../../utils/batch';
import { TodoClient } from './client';

export interface TodoDeviceCode {
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
}

export interface TodoDeviceLoginOptions {
  baseUrl: string;
  /** Shown on Todo's "Where you are signed in" page; at most 80 characters. */
  label: string;
  onCode(code: TodoDeviceCode): void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface StartAnswer {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds?: number;
}

const MAX_CONSECUTIVE_FAILURES = 3;

export function deviceLabel(host: string = hostname()): string {
  return `agentio on ${host}`.slice(0, 80);
}

function startAnswer(data: unknown): StartAnswer {
  const d = data as Partial<StartAnswer> | null;
  if (
    !d
    || typeof d.deviceCode !== 'string' || !d.deviceCode
    || typeof d.userCode !== 'string' || !d.userCode
    || typeof d.verificationUrl !== 'string'
    || typeof d.expiresInSeconds !== 'number'
  ) {
    throw new CliError('API_ERROR', 'Todo answered the sign-in request with something unexpected',
      'Check that the profile URL points at a Todo server');
  }
  return d as StartAnswer;
}

function sameOrigin(url: string, baseUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export async function todoDeviceLogin(options: TodoDeviceLoginOptions): Promise<{ token: string; expiresAt: string }> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const client = new TodoClient({ baseUrl: options.baseUrl, token: '' });

  const started = await client.raw('POST', '/api/auth/device', { auth: false, body: { label: options.label.slice(0, 80) } });
  if (started.status !== 200) throw client.errorFor(started);
  const start = startAnswer(started.data);
  if (!sameOrigin(start.verificationUrl, client.baseUrl)) {
    throw new CliError('API_ERROR', `Todo sent a sign-in page on another site (${start.verificationUrl}); refusing to open it`,
      'Check the profile URL');
  }
  options.onCode({ userCode: start.userCode, verificationUrl: start.verificationUrl, expiresInSeconds: start.expiresInSeconds });

  const deadline = now() + start.expiresInSeconds * 1000;
  let interval = Math.max(start.intervalSeconds ?? 2, 1) * 1000;
  let failures = 0;
  const expired = () => new CliError('AUTH_FAILED', 'The sign-in code expired before it was approved.',
    'Run agentio todo profile add again.');

  for (;;) {
    await sleep(interval);
    if (now() > deadline) throw expired();

    let res;
    try {
      res = await client.raw('POST', '/api/auth/device/token', { auth: false, body: { deviceCode: start.deviceCode } });
    } catch (error) {
      if (++failures > MAX_CONSECUTIVE_FAILURES) throw error;
      continue;
    }
    if (res.status >= 500) {
      if (++failures > MAX_CONSECUTIVE_FAILURES) throw client.errorFor(res);
      continue;
    }
    failures = 0;

    const state = (res.data as { state?: string } | null)?.state;
    if (res.status === 202 && state === 'pending') continue;
    if (res.status === 429) {
      interval *= 2;
      continue;
    }
    if (res.status === 200 && state === 'approved') {
      const { token, expiresAt } = res.data as { token?: unknown; expiresAt?: unknown };
      if (typeof token !== 'string' || !token) {
        throw new CliError('API_ERROR', 'Todo approved the sign-in but sent no token', 'Run agentio todo profile add again.');
      }
      return { token, expiresAt: typeof expiresAt === 'string' ? expiresAt : '' };
    }
    if (res.status === 403 && state === 'denied') throw new CliError('AUTH_FAILED', 'Sign-in was refused in the browser.');
    if (res.status === 410 && state === 'expired') throw expired();
    if (res.status === 401) {
      throw new CliError('AUTH_FAILED', 'Todo no longer knows this sign-in code; it may have been used already.',
        'Run agentio todo profile add again.');
    }
    throw client.errorFor(res);
  }
}
