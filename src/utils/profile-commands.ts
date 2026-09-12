import { Command } from 'commander';
import { getProfileName, listProfiles, setProfileReadOnly } from '../config/config-manager';
import { getCredentials } from '../auth/token-store';
import { pruneDanglingScopes } from '../auth/api-keys';
import { updateVault } from '../vault/vault';
import { handleError, CliError, profileNotFoundError } from './errors';
import type { ServiceName } from '../types/config';

/**
 * Drop a profile, its credentials, and its entry in every key's scope, in one
 * vault write. False when no such profile existed (stray credentials are still
 * cleaned up in that case).
 */
export async function deleteProfile(service: ServiceName, profileName: string): Promise<boolean> {
  let removed = false;
  await updateVault((vault) => {
    const profiles = vault.config.profiles[service] ?? [];
    removed = profiles.some((p) => getProfileName(p) === profileName);
    const hadCredentials = !!vault.credentials[service]?.[profileName];
    if (!removed && !hadCredentials) return;

    vault.config.profiles[service] = profiles.filter((p) => getProfileName(p) !== profileName);
    pruneDanglingScopes(vault.config);
    delete vault.credentials[service]?.[profileName];
  });
  return removed;
}

/**
 * Shared remove logic used both by the per-service `profile remove` command
 * and by the unified `agentio profile remove <service> <name>` command.
 */
export async function removeProfileForService(service: ServiceName, profileName: string): Promise<void> {
  const removed = await deleteProfile(service, profileName);

  if (removed) {
    console.log(`Removed profile "${profileName}"`);
  } else {
    console.error(`Profile "${profileName}" not found`);
  }
}

export interface ProfileCommandsOptions<T> {
  service: ServiceName;
  displayName: string;
  getExtraInfo?: (credentials: T | null) => string;
}

export function createProfileCommands<T>(
  parent: Command,
  options: ProfileCommandsOptions<T>
): Command {
  const { service, displayName, getExtraInfo } = options;

  const profile = parent
    .command('profile')
    .description(`Manage ${displayName} profiles`);

  profile
    .command('list')
    .description(`List ${displayName} profiles`)
    .action(async () => {
      try {
        const result = await listProfiles(service);
        const { profiles } = result[0];

        if (profiles.length === 0) {
          console.log(`No ${displayName} profiles configured.`);
          console.log(`Run: agentio ${service} profile add`);
        } else {
          for (const entry of profiles) {
            const credentials = await getCredentials<T>(service, entry.name);
            const extraInfo = getExtraInfo ? getExtraInfo(credentials) : '';
            const readOnlyIndicator = entry.readOnly ? ' [read-only]' : '';
            console.log(`${entry.name}${readOnlyIndicator}${extraInfo}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('update')
    .description(`Update a ${displayName} profile`)
    .requiredOption('--profile <name>', 'Profile name')
    .option('--read-only', 'Set profile as read-only')
    .option('--no-read-only', 'Remove read-only restriction')
    .action(async (opts) => {
      try {
        const profileName = opts.profile;

        // Check if read-only flag is explicitly set or unset
        if (opts.readOnly === undefined) {
          throw new CliError('INVALID_PARAMS', 'No update specified', 'Use --read-only or --no-read-only');
        }

        if (!(await setProfileReadOnly(service, profileName, opts.readOnly))) {
          throw profileNotFoundError(service, profileName);
        }

        if (opts.readOnly) {
          console.log(`Profile "${profileName}" is now read-only`);
        } else {
          console.log(`Profile "${profileName}" read-only restriction removed`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description(`Remove a ${displayName} profile`)
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (opts) => {
      try {
        await removeProfileForService(service, opts.profile);
      } catch (error) {
        handleError(error);
      }
    });

  return profile;
}
