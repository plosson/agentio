import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getProfileName, loadConfig, updateConfig, listProfileRefs } from '../config/config-manager';
import { CliError } from '../utils/errors';
import type { ApiKey, ApiKeyScope, Config } from '../types/config';
import { decodeToken, encodeToken } from './token';

/** What callers may see: everything but the hash. */
export type ApiKeyView = Omit<ApiKey, 'secretHash'>;

/** Raw caller input; every field is validated here, so routes pass JSON through untouched. */
export interface ApiKeyInput {
  name?: unknown;
  allowedProfiles?: unknown;
  readOnly?: unknown;
}

export interface IssuedKey {
  key: ApiKeyView;
  /** Shown once; only its hash is stored. */
  token: string;
}

/** A touch inside this window is not written; minute granularity is all lastUsedAt needs. */
export const TOUCH_INTERVAL_MS = 60_000;

function view({ secretHash: _hash, ...rest }: ApiKey): ApiKeyView {
  return rest;
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Random secrets need no slow hash; equality is checked in constant time. */
function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const newSecret = () => randomBytes(32).toString('base64url');
const newId = () => randomBytes(6).toString('base64url');
const findKey = (config: Config, id: string) => config.apiKeys?.find((k) => k.id === id);
const noKey = (id: string) => new CliError('NOT_FOUND', `No key with id ${id}`, 'Run: agentio key list');

function validateName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new CliError('INVALID_PARAMS', 'A key needs a name');
  }
  return name.trim();
}

function validateReadOnly(readOnly: unknown): boolean {
  if (typeof readOnly !== 'boolean') throw new CliError('INVALID_PARAMS', 'readOnly must be true or false');
  return readOnly;
}

/** The hub base URL that goes into the token, as the browser or --url saw it. */
function validateHubUrl(url: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new CliError('INVALID_PARAMS', 'The hub URL must be absolute, e.g. https://vault.example.com');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new CliError('INVALID_PARAMS', 'The hub URL must use http or https');
  }
  return parsed.origin;
}

/** `*` or a list of `service/name` pairs that exist in the vault. */
async function validateScope(scope: unknown): Promise<ApiKeyScope> {
  if (scope === '*') return '*';
  if (!Array.isArray(scope) || scope.length === 0 || !scope.every((s) => typeof s === 'string')) {
    throw new CliError('INVALID_PARAMS', 'allowedProfiles must be "*" or a non-empty list of service/name');
  }
  const known = new Set((await listProfileRefs()).map((r) => `${r.service}/${r.name}`));
  const unknown = (scope as string[]).filter((s) => !known.has(s));
  if (unknown.length > 0) {
    throw new CliError(
      'INVALID_PARAMS',
      `Unknown profile${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
      'Use service/name pairs from `agentio profile list`',
    );
  }
  return [...new Set(scope as string[])];
}

/** Find the key or throw NOT_FOUND and apply `mutate`, atomically. */
function withKey<T>(id: string, mutate: (key: ApiKey, config: Config) => T | Promise<T>): Promise<T> {
  return updateConfig((config) => {
    const key = findKey(config, id);
    if (!key) throw noKey(id);
    return mutate(key, config);
  });
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  return ((await loadConfig()).apiKeys ?? []).map(view);
}

export async function createApiKey(input: ApiKeyInput, hubUrl: unknown): Promise<IssuedKey> {
  const name = validateName(input.name);
  const readOnly = validateReadOnly(input.readOnly);
  const url = validateHubUrl(hubUrl);
  const allowedProfiles = await validateScope(input.allowedProfiles);

  const secret = newSecret();
  const key = await updateConfig((config) => {
    const keys = (config.apiKeys ??= []);
    let id = newId();
    while (keys.some((k) => k.id === id)) id = newId();
    const created: ApiKey = { id, name, secretHash: hashSecret(secret), allowedProfiles, readOnly, createdAt: new Date().toISOString() };
    keys.push(created);
    return created;
  });

  return { key: view(key), token: encodeToken({ url, kid: key.id, secret }) };
}

export function updateApiKey(id: string, patch: ApiKeyInput): Promise<ApiKeyView> {
  return withKey(id, async (key) => {
    if (patch.name !== undefined) key.name = validateName(patch.name);
    if (patch.allowedProfiles !== undefined) key.allowedProfiles = await validateScope(patch.allowedProfiles);
    if (patch.readOnly !== undefined) key.readOnly = validateReadOnly(patch.readOnly);
    return view(key);
  });
}

/** New secret, same id and scope. The old token stops working at once. */
export function rotateApiKey(id: string, hubUrl: unknown): Promise<IssuedKey> {
  const url = validateHubUrl(hubUrl);
  return withKey(id, (key) => {
    const secret = newSecret();
    key.secretHash = hashSecret(secret);
    return { key: view(key), token: encodeToken({ url, kid: key.id, secret }) };
  });
}

/** Revoking deletes the record; there is no revoked state to keep or prune. */
export function revokeApiKey(id: string): Promise<void> {
  return withKey(id, (key, config) => {
    config.apiKeys = config.apiKeys!.filter((k) => k !== key);
  });
}

/**
 * Drop scope entries that no longer name a profile in `config`, in place.
 * Called wherever profiles disappear (a delete, a replace-mode import), so
 * re-adding a profile under the same name does not silently re-grant access.
 * `*` keys are untouched. Returns whether anything changed.
 */
export function pruneDanglingScopes(config: Config): boolean {
  const known = new Set(
    Object.entries(config.profiles).flatMap(([service, profiles]) =>
      (profiles ?? []).map((p) => `${service}/${getProfileName(p)}`),
    ),
  );
  let changed = false;
  for (const key of config.apiKeys ?? []) {
    if (key.allowedProfiles === '*') continue;
    const kept = key.allowedProfiles.filter((ref) => known.has(ref));
    if (kept.length !== key.allowedProfiles.length) {
      key.allowedProfiles = kept;
      changed = true;
    }
  }
  return changed;
}

/** The key a token proves possession of, or null. Malformed tokens are null too. */
export async function authenticateToken(token: string): Promise<ApiKeyView | null> {
  let parts;
  try {
    parts = decodeToken(token);
  } catch {
    return null;
  }
  const key = findKey(await loadConfig(), parts.kid);
  if (!key || !secretMatches(parts.secret, key.secretHash)) return null;
  return view(key);
}

/** Whether a key's allow-list covers a profile. */
export function keyAllows(key: ApiKeyView, service: string, profile: string): boolean {
  return key.allowedProfiles === '*' || key.allowedProfiles.includes(`${service}/${profile}`);
}

/** A profile is read-only for a key when either the profile or the key says so. */
export function effectiveReadOnly(key: ApiKeyView, profileReadOnly: boolean | undefined): boolean {
  return key.readOnly || !!profileReadOnly;
}

/** Record use. Skipped when the last record is recent, so a busy key costs one vault write a minute. */
export async function touchApiKey(id: string, at = new Date()): Promise<void> {
  // Cheap check outside the lock: most calls are inside the interval and write nothing.
  const seen = findKey(await loadConfig(), id);
  if (!seen || (seen.lastUsedAt && at.getTime() - Date.parse(seen.lastUsedAt) < TOUCH_INTERVAL_MS)) return;
  await updateConfig((config) => {
    const key = findKey(config, id);
    if (key) key.lastUsedAt = at.toISOString();
  });
}
