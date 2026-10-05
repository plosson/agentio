import { randomBytes, randomInt } from 'crypto';
import { CliError } from '../utils/errors';
import {
  createApiKey,
  keyProvenBy,
  tokenProof,
  validateFlag,
  validateName,
  type ApiKeyInput,
  type ApiKeyView,
  type IssuedKey,
  type TokenProof,
} from '../auth/api-keys';
import { scopeAccess, validateScopes, type Scope } from '../auth/scopes';

/**
 * Device-style login: `agentio login <hub>` asks for a request, prints the
 * user code, and polls. The owner opens the hub UI, checks the code, and approves: exactly the scopes the CLI asked for, or a scope the owner picks when it asked for none. The next poll hands the token over, once. Nothing here
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
  /** The new key's name: what the CLI said, or the replaced key's name when the CLI only defaulted it. */
  name: string;
  createdAt: string;
  expiresAt: string;
  /** What the client asks for; the owner approves exactly this or denies. Absent: the owner picks. */
  scopes?: Scope[];
  /** The machine's current key, which approval revokes. Absent when its token no longer proves one. */
  replaces?: { id: string; name: string; createdAt: string };
}

/** What `agentio login` may add to its name. Every field is validated here. */
export interface DeviceAccessInput {
  scopes?: unknown;
  /** The machine's current token for this hub. */
  replaces?: unknown;
  /** True when the name is the hostname default rather than the user's --name. */
  nameIsDefault?: unknown;
}

/** What the start answers; `scopes` only when some were asked for, so a CLI can tell an older hub. */
export interface DeviceStart {
  userCode: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
  scopes?: Scope[];
}

/** What a poll answers; a request stores its own answer once decided. */
export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'denied' }
  | ({ status: 'approved' } & IssuedKey);

interface PendingRequest {
  userCode: string;
  deviceCode: string;
  name: string;
  createdAt: number;
  scopes?: Scope[];
  /** Never the token: its key id and secret hash. */
  replaces: TokenProof | null;
  nameIsDefault: boolean;
  outcome: DevicePollResult;
  /** An approval is in flight: nobody else may answer the request, and a poll still sees it pending. */
  deciding: boolean;
}

/** Keyed by device code, the one looked up every few seconds; owner lookups scan at most MAX_PENDING entries. */
const requests = new Map<string, PendingRequest>();

const expired = (req: PendingRequest, now: number) => now - req.createdAt > DEVICE_AUTH_TTL_MS;

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
  const code = normalizeUserCode(userCode);
  for (const req of requests.values()) {
    if (req.userCode === code && !expired(req, now) && req.outcome.status === 'pending' && !req.deciding) return req;
  }
  throw unknownCode();
}

export function startDeviceAuth(name: unknown, now = Date.now(), access: DeviceAccessInput = {}): DeviceStart {
  const machine = validateName(name);
  const scopes = access.scopes === undefined ? undefined : validateScopes(access.scopes);
  const nameIsDefault = access.nameIsDefault === undefined ? false : validateFlag('nameIsDefault', access.nameIsDefault);
  for (const req of requests.values()) if (expired(req, now)) requests.delete(req.deviceCode);
  if (requests.size >= MAX_PENDING) {
    throw new CliError('RATE_LIMITED', 'Too many logins waiting for approval, try again in a few minutes');
  }
  const taken = new Set([...requests.values()].map((r) => r.userCode));
  let userCode = newUserCode();
  while (taken.has(userCode)) userCode = newUserCode();
  const req: PendingRequest = {
    userCode,
    deviceCode: randomBytes(32).toString('base64url'),
    name: machine,
    createdAt: now,
    scopes,
    replaces: tokenProof(access.replaces),
    nameIsDefault,
    outcome: { status: 'pending' },
    deciding: false,
  };
  requests.set(req.deviceCode, req);
  return { userCode, deviceCode: req.deviceCode, expiresIn: DEVICE_AUTH_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S, ...(scopes && { scopes }) };
}

/** What the CLI asks every few seconds. A decided request is handed out once and forgotten. */
export function pollDeviceAuth(deviceCode: unknown, now = Date.now()): DevicePollResult {
  const req = typeof deviceCode === 'string' ? requests.get(deviceCode) : undefined;
  if (!req || expired(req, now)) {
    if (req) requests.delete(req.deviceCode);
    throw unknownCode();
  }
  if (req.outcome.status !== 'pending') requests.delete(req.deviceCode);
  return req.outcome;
}

/** The key a request would revoke, if its proof still stands. */
const replacedKey = (req: PendingRequest) => (req.replaces ? keyProvenBy(req.replaces) : Promise.resolve(null));

/** The new key's name: the replaced key's own when the CLI only defaulted it. */
const keyName = (req: PendingRequest, replaced: ApiKeyView | null) => (replaced && req.nameIsDefault ? replaced.name : req.name);

async function viewOf(req: PendingRequest): Promise<DeviceRequestView> {
  const replaced = await replacedKey(req);
  return {
    userCode: req.userCode,
    name: keyName(req, replaced),
    createdAt: new Date(req.createdAt).toISOString(),
    expiresAt: new Date(req.createdAt + DEVICE_AUTH_TTL_MS).toISOString(),
    ...(req.scopes && { scopes: req.scopes }),
    ...(replaced && { replaces: { id: replaced.id, name: replaced.name, createdAt: replaced.createdAt } }),
  };
}

export async function describeDeviceAuth(userCode: string, now = Date.now()): Promise<DeviceRequestView> {
  return viewOf(liveRequest(userCode, now));
}

/** What the owner may still answer, oldest first. Device codes never leave this module. */
export function listDeviceAuth(now = Date.now()): Promise<DeviceRequestView[]> {
  return Promise.all(
    [...requests.values()]
      .filter((req) => req.outcome.status === 'pending' && !req.deciding && !expired(req, now))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(viewOf),
  );
}

/**
 * Creates the key now; the token waits in memory for the CLI's next poll. A
 * scoped request gets exactly its scopes, whatever `input` says; otherwise
 * `input` is the owner's choice. Either way the proven key is revoked in the
 * same write.
 */
export async function approveDeviceAuth(
  userCode: string,
  input: ApiKeyInput,
  hubUrl: unknown,
  now = Date.now(),
): Promise<{ key: ApiKeyView; replaced: ApiKeyView | null }> {
  const req = liveRequest(userCode, now);
  // Claimed before the first await, so a deny or a second approval cannot slip in meanwhile.
  req.deciding = true;
  try {
    const access = req.scopes ? { name: keyName(req, await replacedKey(req)), ...scopeAccess(req.scopes) } : input;
    const { replaced, ...issued } = await createApiKey(access, hubUrl, req.replaces);
    req.outcome = { status: 'approved', ...issued };
    return { key: issued.key, replaced };
  } catch (err) {
    req.deciding = false;
    throw err;
  }
}

export function denyDeviceAuth(userCode: string, now = Date.now()): void {
  liveRequest(userCode, now).outcome = { status: 'denied' };
}

/** Tests only. */
export function resetDeviceAuth(): void {
  requests.clear();
}
