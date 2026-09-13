import { getProfile, getProfileName, putProfileEntry, type SetProfileOptions } from './config-manager';
import { putCredentials } from '../auth/token-store';
import { pruneDanglingScopes } from '../auth/api-keys';
import { updateVault } from '../vault/vault';
import type { ServiceName } from '../types/config';

/**
 * How a profile enters and leaves the vault. Every `profile add` ends in
 * saveProfile, every removal (CLI or admin UI) in deleteProfile, so a change
 * to what a profile is made of happens here and nowhere else.
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
 * Add or replace a profile and its credentials in one vault write. Every
 * `profile add` ends here; deleteProfile is the inverse.
 */
export function saveProfile(
  service: ServiceName,
  profileName: string,
  credentials: object,
  options: SetProfileOptions = {},
): Promise<void> {
  return updateVault((vault) => {
    putProfileEntry(vault.config, service, profileName, options);
    putCredentials(vault.credentials, service, profileName, credentials);
  });
}

/**
 * Drop a profile, its credentials, and its entry in every key's scope, in one
 * vault write. False when no such profile existed (stray credentials are still
 * cleaned up in that case).
 */
export function deleteProfile(service: ServiceName, profileName: string): Promise<boolean> {
  return updateVault((vault) => {
    const profiles = vault.config.profiles[service];
    const removed = !!profiles?.some((p) => getProfileName(p) === profileName);
    if (removed) {
      vault.config.profiles[service] = profiles!.filter((p) => getProfileName(p) !== profileName);
      pruneDanglingScopes(vault.config);
    }
    delete vault.credentials[service]?.[profileName];
    return removed;
  });
}
