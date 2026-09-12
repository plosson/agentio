import { randomBytes, randomInt } from 'crypto';
import { CliError } from '../utils/errors';
import { createApiKey, type ApiKeyInput, type ApiKeyView, type IssuedKey } from '../auth/api-keys';

/**
 * Device-style login: `agentio login <hub>` asks for a request, prints the
 * user code, and polls. The owner opens the hub UI, checks the code, picks a
 * scope, and approves; the next poll hands the token over, once. Nothing here
 * touches the vault until approval, and nothing is persisted: a restart
 * simply forgets pending requests and the CLI starts over.
 */

export const DEVICE_AUTH_TTL_MS = 10 * 60 * 1000;
/** Seconds between polls the CLI is told to keep. */
export const DEVICE_POLL_INTERVAL_S = 3;
/** Pending requests are tiny, but unauthenticated: cap them so a flood cannot grow memory. */
const MAX_PENDING = 100;
/** No vowels or look-alikes, so a code read over the phone survives. */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

export interface DeviceRequestView {
  userCode: string;
  /** What the CLI said it runs on, usually the hostname; the owner can rename the key. */
  name: string;
  createdAt: string;
  expiresAt: string;
}

export type DevicePollResult =
  | { status: 'pending'; interval: number }
  | { status: 'denied' }
  | ({ status: 'approved' } & IssuedKey);

interface PendingRequest {
  userCode: string;
  deviceCode: string;
  name: string;
  createdAt: number;
  outcome: 'pending' | 'denied' | { issued: IssuedKey };
}

const byUserCode = new Map<string, PendingRequest>();
const byDeviceCode = new Map<string, PendingRequest>();

const expired = (req: PendingRequest, now: number) => now - req.createdAt > DEVICE_AUTH_TTL_MS;

function forget(req: PendingRequest): void {
  byUserCode.delete(req.userCode);
  byDeviceCode.delete(req.deviceCode);
}

function sweep(now: number): void {
  for (const req of byUserCode.values()) if (expired(req, now)) forget(req);
}

function newUserCode(): string {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const part = () => pick() + pick() + pick() + pick();
  return `${part()}-${part()}`;
}

/** Accepts the code however the owner typed or pasted it: case, spaces and the hyphen are optional. */
export function normalizeUserCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

const unknownCode = () =>
  new CliError('NOT_FOUND', 'Unknown or expired login code', 'Run `agentio login` again to get a new one');

/** A request the owner can still act on, or NOT_FOUND. */
function liveRequest(userCode: string, now: number): PendingRequest {
  const req = byUserCode.get(normalizeUserCode(userCode));
  if (!req || expired(req, now) || req.outcome !== 'pending') throw unknownCode();
  return req;
}

export function startDeviceAuth(name: unknown, now = Date.now()): { userCode: string; deviceCode: string; expiresIn: number; interval: number } {
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 64) {
    throw new CliError('INVALID_PARAMS', 'name must be 1 to 64 characters');
  }
  sweep(now);
  if (byUserCode.size >= MAX_PENDING) {
    throw new CliError('RATE_LIMITED', 'Too many logins waiting for approval, try again in a few minutes');
  }
  let userCode = newUserCode();
  while (byUserCode.has(userCode)) userCode = newUserCode();
  const req: PendingRequest = { userCode, deviceCode: randomBytes(32).toString('base64url'), name: name.trim(), createdAt: now, outcome: 'pending' };
  byUserCode.set(userCode, req);
  byDeviceCode.set(req.deviceCode, req);
  return { userCode, deviceCode: req.deviceCode, expiresIn: DEVICE_AUTH_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
}

/** What the CLI asks every few seconds. A decided request is handed out once and forgotten. */
export function pollDeviceAuth(deviceCode: unknown, now = Date.now()): DevicePollResult {
  const req = typeof deviceCode === 'string' ? byDeviceCode.get(deviceCode) : undefined;
  if (!req || expired(req, now)) {
    if (req) forget(req);
    throw unknownCode();
  }
  if (req.outcome === 'pending') return { status: 'pending', interval: DEVICE_POLL_INTERVAL_S };
  forget(req);
  return req.outcome === 'denied' ? { status: 'denied' } : { status: 'approved', ...req.outcome.issued };
}

export function describeDeviceAuth(userCode: string, now = Date.now()): DeviceRequestView {
  const req = liveRequest(userCode, now);
  return {
    userCode: req.userCode,
    name: req.name,
    createdAt: new Date(req.createdAt).toISOString(),
    expiresAt: new Date(req.createdAt + DEVICE_AUTH_TTL_MS).toISOString(),
  };
}

/** Creates the key now; the token waits in memory for the CLI's next poll. */
export async function approveDeviceAuth(userCode: string, input: ApiKeyInput, hubUrl: unknown, now = Date.now()): Promise<ApiKeyView> {
  const req = liveRequest(userCode, now);
  const issued = await createApiKey(input, hubUrl);
  req.outcome = { issued };
  return issued.key;
}

export function denyDeviceAuth(userCode: string, now = Date.now()): void {
  liveRequest(userCode, now).outcome = 'denied';
}

/** Tests only. */
export function resetDeviceAuth(): void {
  byUserCode.clear();
  byDeviceCode.clear();
}
