import { findProfileIndex, getProfile, hasProfile, optionsOf, profileRef, putProfileEntry, renameProfileEntry, type SetProfileOptions } from './config-manager';
import { putCredentials } from '../auth/token-store';
import { grantProfileToKey, keyAllows, keyInConfig, pruneDanglingScopes, renameProfileInScopes } from '../auth/api-keys';
import { updateVault, type VaultContents } from '../vault/vault';
import { hub, isRemoteMode, remoteDeleteProfile, remoteRenameProfile, remoteSaveProfile } from '../auth/remote';
import { CliError, profileNotFoundError } from '../utils/errors';
import type { Config, ServiceName } from '../types/config';

/**
 * How a profile enters, moves and leaves the vault. saveProfile, renameProfile
 * and deleteProfile are what the CLI and the admin UI call, each running
 * locally or, in remote mode, as one call to the hub. The `…ForKey` trio is
 * the hub's own side of those calls, authorised against an API key. All of
 * them go through putProfile, moveProfile or removeProfile, so a change to
 * what a profile is made of happens here and nowhere else.
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
 * In remote mode only the key's allow-listed names are visible, so a name
 * taken outside the allow-list is not seen here and the hub refuses the write.
 */
export async function chooseProfileName(
  service: ServiceName,
  { explicit, derived, readOnly }: ProfileNameChoice,
): Promise<string> {
  if (explicit) return explicit;
  if (readOnly && (await getProfile(service, derived))) return `${derived}-readonly`;
  return derived;
}

/** Add or replace a profile and its credentials in one vault write, or one PUT to the hub. */
export function saveProfile(
  service: ServiceName,
  profileName: string,
  credentials: object,
  options: SetProfileOptions = {},
): Promise<void> {
  if (isRemoteMode()) return remoteSaveProfile(service, profileName, credentials, options)
    .then(() => { console.error(`Stored on the vault hub at ${hub().url}`); });
  return updateVault((vault) => {
    const index = findProfileIndex(vault.config, service, profileName);
    putProfile(vault, service, profileName, credentials, keptOptions(vault, service, index, options));
  });
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

/**
 * The flags a write ends up with. A replace keeps what the owner set unless
 * this write states something: the repair case sends credentials alone, and
 * must not silently unlock a profile the owner marked read-only. An explicit
 * `false` still clears it, since that is a statement.
 */
function keptOptions(vault: VaultContents, service: ServiceName, index: number, options: SetProfileOptions): SetProfileOptions {
  if (index === -1) return options;
  return { readOnly: options.readOnly ?? optionsOf(vault.config.profiles[service]![index]).readOnly };
}

/** The one place a profile is written: its entry and its credentials, in place. */
function putProfile(vault: VaultContents, service: ServiceName, profileName: string, credentials: object, options: SetProfileOptions): void {
  validateProfileName(profileName);
  putProfileEntry(vault.config, service, profileName, options);
  putCredentials(vault.credentials, service, profileName, credentials);
}

/**
 * What a write did, or why it did nothing. The caller turns this into an
 * error; the store never words one, because the same outcome reads
 * differently to a hub client and to the owner at the CLI.
 */
export type WriteOutcome = 'ok' | 'denied' | 'absent' | 'taken';

/**
 * The error for a write that did nothing, or undefined for one that did. Every
 * caller words it the same way, so a refusal reads alike at the CLI, on the
 * hub and in the admin UI.
 */
export function writeFailure(outcome: WriteOutcome, service: ServiceName, name: string, to?: string): CliError | undefined {
  switch (outcome) {
    case 'ok': return undefined;
    case 'absent': return profileNotFoundError(service, name);
    case 'denied': return new CliError('PERMISSION_DENIED', `This token is not allowed to use ${profileRef(service, name)}`,
      'Ask the hub owner to widen this key, or choose a name it already covers');
    case 'taken': return new CliError('INVALID_PARAMS', `Profile ${profileRef(service, to ?? name)} already exists`,
      'Choose another name');
  }
}

/**
 * The vault has one owner, so a managing key is that owner on another machine
 * and may replace or drop what its allow-list already reaches. A name nobody
 * holds yet is free to create, and the key gains it in the same write. The key
 * is re-read here rather than trusted from the request: a rename moves the
 * very allow-list it was checked against, and the owner may revoke mid-request.
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
): Promise<WriteOutcome> {
  return updateVault((vault) => {
    const index = findProfileIndex(vault.config, service, profileName);
    if (index !== -1 && !reaches(vault.config, keyId, service, profileName)) return 'denied';
    putProfile(vault, service, profileName, credentials, keptOptions(vault, service, index, options));
    grantProfileToKey(vault.config, keyId, service, profileName);
    return 'ok';
  });
}

/** Drop a profile for a remote key, when the key reaches it. */
export function deleteProfileForKey(keyId: string, service: ServiceName, profileName: string): Promise<WriteOutcome> {
  return updateVault((vault) => {
    if (!hasProfile(vault.config, service, profileName)) return 'absent';
    if (!reaches(vault.config, keyId, service, profileName)) return 'denied';
    removeProfile(vault, service, profileName);
    return 'ok';
  });
}

/** Rename a profile for a remote key, when the key reaches it and the new name is free. */
export function renameProfileForKey(keyId: string, service: ServiceName, from: string, to: string): Promise<WriteOutcome> {
  return updateVault((vault) => {
    if (!hasProfile(vault.config, service, from)) return 'absent';
    if (!reaches(vault.config, keyId, service, from)) return 'denied';
    return moveProfile(vault, service, from, to);
  });
}

/**
 * Move a profile to a new name: its entry keeps its flag, its credentials
 * follow, and every key that named it is updated, all in one vault write.
 */
export function renameProfile(service: ServiceName, from: string, to: string): Promise<WriteOutcome> {
  if (isRemoteMode()) {
    validateProfileName(to);
    return remoteRenameProfile(service, from, to);
  }
  return updateVault((vault) => moveProfile(vault, service, from, to));
}

/** The move itself, in place; validation included so no caller can skip it. */
function moveProfile(vault: VaultContents, service: ServiceName, from: string, to: string): WriteOutcome {
  validateProfileName(to);
  const index = findProfileIndex(vault.config, service, from);
  if (index === -1) return 'absent';
  if (from !== to && hasProfile(vault.config, service, to)) return 'taken';

  renameProfileEntry(vault.config, service, index, to);
  const stored = vault.credentials[service]?.[from];
  if (stored !== undefined && from !== to) {
    putCredentials(vault.credentials, service, to, stored);
    delete vault.credentials[service]![from];
  }
  renameProfileInScopes(vault.config, service, from, to);
  return 'ok';
}

/**
 * Drop a profile, its credentials, and its entry in every key's scope, in one
 * vault write. False when no such profile existed (stray credentials are still
 * cleaned up in that case).
 */
export function deleteProfile(service: ServiceName, profileName: string): Promise<boolean> {
  if (isRemoteMode()) return remoteDeleteProfile(service, profileName).then((o) => o === 'ok');
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
