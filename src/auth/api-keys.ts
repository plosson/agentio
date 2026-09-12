import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { loadConfig, saveConfig, listProfileRefs } from '../config/config-manager';
import { CliError } from '../utils/errors';
import type { ApiKey, ApiKeyScope, ServiceName } from '../types/config';
import { decodeToken, encodeToken } from './token';

/** What callers may see: everything but the hash. */
export type ApiKeyView = Omit<ApiKey, 'secretHash'>;

/** Raw caller input; every field is validated here, so routes pass JSON through untouched. */
export interface ApiKeyInput {
  name: unknown;
  allowedProfiles: unknown;
  readOnly: unknown;
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
export function validateHubUrl(url: unknown): string {
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

/** Load, find the key or throw NOT_FOUND, apply `mutate`, save. */
async function withKey<T>(id: string, mutate: (key: ApiKey) => T | Promise<T>): Promise<T> {
  const config = await loadConfig();
  const key = config.apiKeys?.find((k) => k.id === id);
  if (!key) throw new CliError('NOT_FOUND', `No key with id ${id}`, 'Run: agentio key list');
  const result = await mutate(key);
  await saveConfig(config);
  return result;
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  return ((await loadConfig()).apiKeys ?? []).map(view);
}

export async function createApiKey(input: ApiKeyInput, hubUrl: unknown): Promise<IssuedKey> {
  const name = validateName(input.name);
  const allowedProfiles = await validateScope(input.allowedProfiles);
  const readOnly = validateReadOnly(input.readOnly);
  const url = validateHubUrl(hubUrl);

  const config = await loadConfig();
  const keys = config.apiKeys ?? [];
  let id = randomBytes(6).toString('base64url');
  while (keys.some((k) => k.id === id)) id = randomBytes(6).toString('base64url');
  const secret = newSecret();
  const key: ApiKey = { id, name, secretHash: hashSecret(secret), allowedProfiles, readOnly, createdAt: new Date().toISOString() };
  config.apiKeys = [...keys, key];
  await saveConfig(config);

  return { key: view(key), token: encodeToken({ url, kid: id, secret }) };
}

export function updateApiKey(id: string, patch: Partial<ApiKeyInput>): Promise<ApiKeyView> {
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
export async function revokeApiKey(id: string): Promise<void> {
  const config = await loadConfig();
  const keys = config.apiKeys ?? [];
  if (!keys.some((k) => k.id === id)) throw new CliError('NOT_FOUND', `No key with id ${id}`, 'Run: agentio key list');
  config.apiKeys = keys.filter((k) => k.id !== id);
  await saveConfig(config);
}

/**
 * Drop `service/name` from every key's allow-list when that profile is deleted,
 * so re-adding a profile under the same name does not silently re-grant access.
 * `*` keys are untouched.
 */
export async function pruneProfileFromKeys(service: ServiceName, name: string): Promise<void> {
  const config = await loadConfig();
  const ref = `${service}/${name}`;
  let changed = false;
  for (const key of config.apiKeys ?? []) {
    if (key.allowedProfiles === '*' || !key.allowedProfiles.includes(ref)) continue;
    key.allowedProfiles = key.allowedProfiles.filter((p) => p !== ref);
    changed = true;
  }
  if (changed) await saveConfig(config);
}

/** The key a token proves possession of, or null. Malformed tokens are null too. */
export async function authenticateToken(token: string): Promise<ApiKeyView | null> {
  let parts;
  try {
    parts = decodeToken(token);
  } catch {
    return null;
  }
  const key = (await loadConfig()).apiKeys?.find((k) => k.id === parts.kid);
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
  const config = await loadConfig();
  const key = config.apiKeys?.find((k) => k.id === id);
  if (!key) return;
  if (key.lastUsedAt && at.getTime() - Date.parse(key.lastUsedAt) < TOUCH_INTERVAL_MS) return;
  key.lastUsedAt = at.toISOString();
  await saveConfig(config);
}
