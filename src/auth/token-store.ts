import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { hostname, userInfo } from 'os';
import { CONFIG_DIR, ensureConfigDir } from '../config/config-manager';
import type { StoredCredentials } from '../types/tokens';
import type { ServiceName } from '../types/config';

const TOKENS_FILE = join(CONFIG_DIR, 'tokens.enc');
const ALGORITHM = 'aes-256-gcm';

// Derive a machine-specific key from hostname + username
function deriveKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-agentio-v1`;
  return scryptSync(machineId, 'agentio-salt', 32);
}

async function loadCredentials(): Promise<StoredCredentials> {
  await ensureConfigDir();

  if (!existsSync(TOKENS_FILE)) {
    return {};
  }

  try {
    const encrypted = await readFile(TOKENS_FILE, 'utf-8');
    const { iv, tag, data } = JSON.parse(encrypted);

    const key = deriveKey();
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, 'hex')),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString('utf-8'));
  } catch {
    // File corrupted, tampered, or key changed - return empty credentials
    return {};
  }
}

async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  await ensureConfigDir();

  const key = deriveKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const data = JSON.stringify(credentials);
  const encrypted = Buffer.concat([
    cipher.update(data, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  const stored = JSON.stringify({
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  });

  await writeFile(TOKENS_FILE, stored, { mode: 0o600 });
}

export async function getCredentials<T = Record<string, unknown>>(
  service: ServiceName,
  profile: string
): Promise<T | null> {
  const credentials = await loadCredentials();
  return (credentials[service]?.[profile] as T) || null;
}

export async function setCredentials(
  service: ServiceName,
  profile: string,
  data: object
): Promise<void> {
  const credentials = await loadCredentials();

  if (!credentials[service]) {
    credentials[service] = {};
  }

  credentials[service][profile] = data as Record<string, unknown>;
  await saveCredentials(credentials);
}

export async function removeCredentials(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const credentials = await loadCredentials();

  if (!credentials[service]?.[profile]) {
    return false;
  }

  delete credentials[service][profile];
  await saveCredentials(credentials);
  return true;
}

export async function hasCredentials(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const credentials = await loadCredentials();
  return !!credentials[service]?.[profile];
}

export async function getAllCredentials(): Promise<StoredCredentials> {
  return loadCredentials();
}

export async function setAllCredentials(credentials: StoredCredentials): Promise<void> {
  return saveCredentials(credentials);
}
