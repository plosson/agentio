import { findProfileIndex, getProfile, hasProfile, putProfileEntry, type SetProfileOptions } from './config-manager';
import { putCredentials } from '../auth/token-store';
import { grantProfileToKey, pruneDanglingScopes } from '../auth/api-keys';
import { updateVault, type VaultContents } from '../vault/vault';
import { isRemoteMode, remoteAddProfile } from '../auth/remote';
import { CliError } from '../utils/errors';
import type { ServiceName } from '../types/config';

/**
 * How a profile enters and leaves the vault. A local `profile add` ends in
 * saveProfile, a remote one in addProfileForKey on the hub, and both go
 * through putProfile; every removal (CLI or admin UI) is deleteProfile. So a
 * change to what a profile is made of happens here and nowhere else.
 */

export interface ProfileNameChoice {
  /** `--profile`, taken as is. */
  explicit?: string;
  /** What the service knows the account as: an email, a login, a hostname. */
  derived: string;
  readOnly?: boolean;
}

/**
 * The name a new profile gets. An explicit `--profile` wins. Otherwise the
 * derived name, unless the profile is read-only and that name is taken
 * already: then `<derived>-readonly`, so one account can have a full and a
 * read-only profile side by side without the second overwriting the first.
 * In remote mode only the key's allow-listed names are visible, so a
 * collision outside it surfaces as the hub's error rather than a rename.
 */
export async function chooseProfileName(
  service: ServiceName,
  { explicit, derived, readOnly }: ProfileNameChoice,
): Promise<string> {
  if (explicit) return explicit;
  if (readOnly && (await getProfile(service, derived))) return `${derived}-readonly`;
  return derived;
}

/**
 * Add or replace a profile and its credentials in one vault write; deleteProfile
 * is the inverse. In remote mode the vault is on the hub, so the same call is
 * one PUT there (create-only, see addProfileForKey).
 */
export function saveProfile(
  service: ServiceName,
  profileName: string,
  credentials: object,
  options: SetProfileOptions = {},
): Promise<void> {
  if (isRemoteMode()) return remoteAddProfile(service, profileName, credentials, options);
  return updateVault((vault) => putProfile(vault, service, profileName, credentials, options));
}

/**
 * A name is one path segment on the hub and one half of a key's allow-list
 * entry, so it cannot be empty or contain "/". Checked once, here, for the
 * local and the remote add alike.
 */
function validateProfileName(profileName: string): void {
  if (!profileName.trim() || profileName.includes('/')) {
    throw new CliError('INVALID_PARAMS', `Invalid profile name "${profileName}"`, 'A name cannot be empty or contain "/"');
  }
}

/** The one place a profile is written: its entry and its credentials, in place. */
function putProfile(vault: VaultContents, service: ServiceName, profileName: string, credentials: object, options: SetProfileOptions): void {
  validateProfileName(profileName);
  putProfileEntry(vault.config, service, profileName, options);
  putCredentials(vault.credentials, service, profileName, credentials);
}

/**
 * The hub's add on behalf of a remote key. Create-only: false, and nothing
 * written, when the name is taken, so a key cannot swap the credentials
 * behind a profile other agents use. The key gains the profile on its
 * allow-list in the same write, so what it just added it can use.
 */
export function addProfileForKey(
  keyId: string,
  service: ServiceName,
  profileName: string,
  credentials: object,
  options: SetProfileOptions,
): Promise<boolean> {
  return updateVault((vault) => {
    if (hasProfile(vault.config, service, profileName)) return false;
    putProfile(vault, service, profileName, credentials, options);
    grantProfileToKey(vault.config, keyId, service, profileName);
    return true;
  });
}

/**
 * Drop a profile, its credentials, and its entry in every key's scope, in one
 * vault write. False when no such profile existed (stray credentials are still
 * cleaned up in that case).
 */
export function deleteProfile(service: ServiceName, profileName: string): Promise<boolean> {
  return updateVault((vault) => {
    const index = findProfileIndex(vault.config, service, profileName);
    const removed = index !== -1;
    if (removed) {
      vault.config.profiles[service]!.splice(index, 1);
      pruneDanglingScopes(vault.config);
    }
    delete vault.credentials[service]?.[profileName];
    return removed;
  });
}
