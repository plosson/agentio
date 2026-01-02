import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { hostname, userInfo } from 'os';
import { CONFIG_DIR, ensureConfigDir } from '../config/config-manager';
import type { OAuthTokens, StoredTokens } from '../types/tokens';
import type { ServiceName } from '../types/config';

const TOKENS_FILE = join(CONFIG_DIR, 'tokens.enc');
const ALGORITHM = 'aes-256-gcm';

// Derive a machine-specific key from hostname + username
function deriveKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-allcli-v1`;
  return scryptSync(machineId, 'allcli-salt', 32);
}

async function loadTokens(): Promise<StoredTokens> {
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
    // File corrupted, tampered, or key changed - return empty tokens
    return {};
  }
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await ensureConfigDir();

  const key = deriveKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const data = JSON.stringify(tokens);
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

export async function getTokens(
  service: ServiceName,
  profile: string
): Promise<OAuthTokens | null> {
  const tokens = await loadTokens();
  return tokens[service]?.[profile] || null;
}

export async function setTokens(
  service: ServiceName,
  profile: string,
  oauthTokens: OAuthTokens
): Promise<void> {
  const tokens = await loadTokens();

  if (!tokens[service]) {
    tokens[service] = {};
  }

  tokens[service][profile] = oauthTokens;
  await saveTokens(tokens);
}

export async function removeTokens(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const tokens = await loadTokens();

  if (!tokens[service]?.[profile]) {
    return false;
  }

  delete tokens[service][profile];
  await saveTokens(tokens);
  return true;
}

export async function hasTokens(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const tokens = await loadTokens();
  return !!tokens[service]?.[profile];
}
