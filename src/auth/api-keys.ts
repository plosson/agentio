import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { loadConfig, saveConfig, listProfiles } from '../config/config-manager';
import { CliError } from '../utils/errors';
import type { ApiKey, ApiKeyScope } from '../types/config';
import { decodeToken, encodeToken } from './token';

/** What callers may see: everything but the hash. */
export type ApiKeyView = Omit<ApiKey, 'secretHash'>;

export interface ApiKeyInput {
  name: string;
  allowedProfiles: ApiKeyScope;
  readOnly: boolean;
}

export interface IssuedKey {
  key: ApiKeyView;
  /** Shown once; only its hash is stored. */
  token: string;
}

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
  const known = new Set(
    (await listProfiles()).flatMap(({ service, profiles }) => profiles.map((p) => `${service}/${p.name}`)),
  );
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

function mint(): { kid: string; secret: string } {
  return { kid: randomBytes(6).toString('base64url'), secret: randomBytes(32).toString('base64url') };
}

export async function listApiKeys(): Promise<ApiKeyView[]> {
  return ((await loadConfig()).apiKeys ?? []).map(view);
}

export async function createApiKey(input: ApiKeyInput, hubUrl: string): Promise<IssuedKey> {
  const name = validateName(input.name);
  const allowedProfiles = await validateScope(input.allowedProfiles);
  const readOnly = validateReadOnly(input.readOnly);
  const url = validateHubUrl(hubUrl);

  const config = await loadConfig();
  const { kid, secret } = mint();
  const key: ApiKey = {
    id: kid,
    name,
    secretHash: hashSecret(secret),
    allowedProfiles,
    readOnly,
    createdAt: new Date().toISOString(),
  };
  config.apiKeys = [...(config.apiKeys ?? []), key];
  await saveConfig(config);

  return { key: view(key), token: encodeToken({ url, kid, secret }) };
}

export async function updateApiKey(
  id: string,
  patch: Partial<ApiKeyInput>,
): Promise<ApiKeyView | null> {
  const config = await loadConfig();
  const key = config.apiKeys?.find((k) => k.id === id);
  if (!key) return null;

  if (patch.name !== undefined) key.name = validateName(patch.name);
  if (patch.allowedProfiles !== undefined) key.allowedProfiles = await validateScope(patch.allowedProfiles);
  if (patch.readOnly !== undefined) key.readOnly = validateReadOnly(patch.readOnly);

  await saveConfig(config);
  return view(key);
}

/** New secret, same id and scope. The old token stops working at once. */
export async function rotateApiKey(id: string, hubUrl: string): Promise<IssuedKey | null> {
  const url = validateHubUrl(hubUrl);
  const config = await loadConfig();
  const key = config.apiKeys?.find((k) => k.id === id);
  if (!key) return null;

  const { secret } = mint();
  key.secretHash = hashSecret(secret);
  await saveConfig(config);

  return { key: view(key), token: encodeToken({ url, kid: key.id, secret }) };
}

/** Revoking deletes the record; there is no revoked state to keep or prune. */
export async function revokeApiKey(id: string): Promise<boolean> {
  const config = await loadConfig();
  const before = config.apiKeys?.length ?? 0;
  config.apiKeys = (config.apiKeys ?? []).filter((k) => k.id !== id);
  if (config.apiKeys.length === before) return false;
  await saveConfig(config);
  return true;
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

/** Whether a key may use a profile, and whether only read-only. */
export function keyAllows(key: ApiKeyView, service: string, profile: string): boolean {
  return key.allowedProfiles === '*' || key.allowedProfiles.includes(`${service}/${profile}`);
}

export async function touchApiKey(id: string, at = new Date()): Promise<void> {
  const config = await loadConfig();
  const key = config.apiKeys?.find((k) => k.id === id);
  if (!key) return;
  key.lastUsedAt = at.toISOString();
  await saveConfig(config);
}
