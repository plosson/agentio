import { Command } from 'commander';
import { listProfiles, removeProfile, setProfileReadOnly } from '../config/config-manager';
import { removeCredentials, getCredentials } from '../auth/token-store';
import { handleError, CliError } from './errors';
import type { ServiceName } from '../types/config';

/**
 * Shared remove logic used both by the per-service `profile remove` command
 * and by the unified `agentio profile remove <service> <name>` command.
 */
export async function removeProfileForService(service: ServiceName, profileName: string): Promise<void> {
  const removed = await removeProfile(service, profileName);
  await removeCredentials(service, profileName);

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

        const updated = await setProfileReadOnly(service, profileName, opts.readOnly);
        if (!updated) {
          throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found`);
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
