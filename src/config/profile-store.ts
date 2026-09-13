import { findProfileIndex, getProfile, hasProfile, putProfileEntry, type SetProfileOptions } from './config-manager';
import { putCredentials } from '../auth/token-store';
import { grantProfileToKey, keyAllows, keyInConfig, pruneDanglingScopes, renameProfileInScopes } from '../auth/api-keys';
import { updateVault, type VaultContents } from '../vault/vault';
import { hub, isRemoteMode, remoteDeleteProfile, remoteRenameProfile, remoteSaveProfile } from '../auth/remote';
import { CliError } from '../utils/errors';
import type { Config, ServiceName } from '../types/config';

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
  if (isRemoteMode()) return remoteSaveProfile(service, profileName, credentials, options)
    .then(() => { console.error(`Stored on the vault hub at ${hub().url}`); });
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
 * Why the hub-side operations take a key: the vault has one owner, so a
 * managing key is that owner on another machine and may replace or drop what
 * it can already reach. The allow-list still bounds it. A name nobody holds
 * yet is free to create, and the key gains it in the same write; a name the
 * key cannot see is refused, since touching it is a mistake rather than an
 * intent. `false` means nothing was written.
 */
function reaches(config: Config, keyId: string, service: ServiceName, profileName: string): boolean {
  const key = keyInConfig(config, keyId);
  return !!key && keyAllows(key, service, profileName);
}

/** Add a profile for a remote key, or replace one it already reaches. */
export function saveProfileForKey(
  keyId: string,
  service: ServiceName,
  profileName: string,
  credentials: object,
  options: SetProfileOptions,
): Promise<boolean> {
  return updateVault((vault) => {
    const free = !hasProfile(vault.config, service, profileName);
    if (!free && !reaches(vault.config, keyId, service, profileName)) return false;
    putProfile(vault, service, profileName, credentials, options);
    grantProfileToKey(vault.config, keyId, service, profileName);
    return true;
  });
}

/** Drop a profile for a remote key, when the key reaches it. */
export function deleteProfileForKey(keyId: string, service: ServiceName, profileName: string): Promise<boolean> {
  return updateVault((vault) =>
    reaches(vault.config, keyId, service, profileName) && removeProfile(vault, service, profileName));
}

/** Rename a profile for a remote key, when the key reaches it and the new name is free. */
export function renameProfileForKey(keyId: string, service: ServiceName, from: string, to: string): Promise<RenameResult> {
  return updateVault((vault) =>
    reaches(vault.config, keyId, service, from) ? moveProfile(vault, service, from, to) : 'not-found');
}

export type RenameResult = 'renamed' | 'not-found' | 'taken';

/**
 * Move a profile to a new name: its entry keeps its flag, its credentials
 * follow, and every key that named it is updated, all in one vault write.
 */
export function renameProfile(service: ServiceName, from: string, to: string): Promise<RenameResult> {
  if (isRemoteMode()) {
    validateProfileName(to);
    return remoteRenameProfile(service, from, to).then((ok) => (ok ? 'renamed' : 'not-found'));
  }
  return updateVault((vault) => moveProfile(vault, service, from, to));
}

/** The move itself, in place; validation included so no caller can skip it. */
function moveProfile(vault: VaultContents, service: ServiceName, from: string, to: string): RenameResult {
  validateProfileName(to);
  if (from === to) return hasProfile(vault.config, service, from) ? 'renamed' : 'not-found';
  const index = findProfileIndex(vault.config, service, from);
  if (index === -1) return 'not-found';
  if (hasProfile(vault.config, service, to)) return 'taken';

  const entry = vault.config.profiles[service]![index];
  const readOnly = typeof entry === 'string' ? undefined : entry.readOnly;
  vault.config.profiles[service]![index] = { name: to, ...(readOnly ? { readOnly: true } : {}) };

  const stored = vault.credentials[service]?.[from];
  if (stored !== undefined) {
    putCredentials(vault.credentials, service, to, stored);
    delete vault.credentials[service]![from];
  }
  renameProfileInScopes(vault.config, service, from, to);
  return 'renamed';
}

/**
 * Drop a profile, its credentials, and its entry in every key's scope, in one
 * vault write. False when no such profile existed (stray credentials are still
 * cleaned up in that case).
 */
export function deleteProfile(service: ServiceName, profileName: string): Promise<boolean> {
  if (isRemoteMode()) return remoteDeleteProfile(service, profileName);
  return updateVault((vault) => removeProfile(vault, service, profileName));
}

/** The entry, its credentials and its place in every key's scope, gone. In place. */
function removeProfile(vault: VaultContents, service: ServiceName, profileName: string): boolean {
  const index = findProfileIndex(vault.config, service, profileName);
  const removed = index !== -1;
  if (removed) {
    vault.config.profiles[service]!.splice(index, 1);
    pruneDanglingScopes(vault.config);
  }
  delete vault.credentials[service]?.[profileName];
  return removed;
}
