import { loadVault, saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import type { StoredCredentials } from '../types/tokens';
import type { ServiceName } from '../types/config';

async function loadCredentials(): Promise<StoredCredentials> {
  const vault = await loadVault();
  return vault.credentials;
}

async function saveCredentials(credentials: StoredCredentials): Promise<void> {
  const vault = await loadVault();
  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: vault.config,
    credentials,
  });
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
  if (!credentials[service]) credentials[service] = {};
  credentials[service][profile] = data as Record<string, unknown>;
  await saveCredentials(credentials);
}

export async function removeCredentials(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const credentials = await loadCredentials();
  if (!credentials[service]?.[profile]) return false;
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
