import { loadVault, updateVault } from '../vault/vault';
import { isRemoteMode, remoteCredentials } from './remote';
import type { StoredCredentials } from '../types/tokens';
import type { ServiceName } from '../types/config';

export async function getCredentials<T = Record<string, unknown>>(
  service: ServiceName,
  profile: string
): Promise<T | null> {
  if (isRemoteMode()) return remoteCredentials<T>(service, profile);
  const { credentials } = await loadVault();
  return (credentials[service]?.[profile] as T) || null;
}

export async function setCredentials(
  service: ServiceName,
  profile: string,
  data: object
): Promise<void> {
  await updateVault(({ credentials }) => {
    (credentials[service] ??= {})[profile] = data as Record<string, unknown>;
  });
}

export async function getAllCredentials(): Promise<StoredCredentials> {
  return (await loadVault()).credentials;
}

export async function setAllCredentials(credentials: StoredCredentials): Promise<void> {
  await updateVault((vault) => { vault.credentials = credentials; });
}
