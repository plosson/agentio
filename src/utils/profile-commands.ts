import { Command } from 'commander';
import { listProfiles, setProfileReadOnly } from '../config/config-manager';
import { getCredentials } from '../auth/token-store';
import { deleteProfile, renameProfile, writeFailure } from '../config/profile-store';
import { handleError, CliError, profileNotFoundError } from './errors';
import type { ServiceName } from '../types/config';

/**
 * Shared remove logic used both by the per-service `profile remove` command
 * and by the unified `agentio profile remove <service> <name>` command.
 */
export async function removeProfileForService(service: ServiceName, profileName: string): Promise<void> {
  // Nothing removed has to fail: remotely it also covers a profile the key
  // cannot reach, and a script must not read that as a removal.
  if (!(await deleteProfile(service, profileName))) throw profileNotFoundError(service, profileName);
  console.log(`Removed profile "${profileName}"`);
}

/**
 * Shared rename logic for the unified `agentio profile rename` and the
 * per-service one. The credentials and every key scope follow the new name.
 */
export async function renameProfileForService(service: ServiceName, from: string, to: string): Promise<void> {
  const failure = writeFailure(await renameProfile(service, from, to), service, from, to);
  if (failure) throw failure;
  console.log(`Renamed profile "${from}" to "${to}"`);
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
    .command('rename')
    .description(`Rename a ${displayName} profile`)
    .requiredOption('--profile <name>', 'Current profile name')
    .requiredOption('--to <name>', 'New profile name')
    .action(async (opts) => {
      try {
        await renameProfileForService(service, opts.profile, opts.to);
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
