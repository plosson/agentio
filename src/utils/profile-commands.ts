import { Command } from 'commander';
import { listProfiles, removeProfile } from '../config/config-manager';
import { removeCredentials, getCredentials } from '../auth/token-store';
import { handleError } from './errors';
import type { ServiceName } from '../types/config';

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
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const credentials = await getCredentials<T>(service, name);
            const extraInfo = getExtraInfo ? getExtraInfo(credentials) : '';
            console.log(`${name}${extraInfo}`);
          }
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
        const profileName = opts.profile;

        const removed = await removeProfile(service, profileName);
        await removeCredentials(service, profileName);

        if (removed) {
          console.log(`Removed profile "${profileName}"`);
        } else {
          console.error(`Profile "${profileName}" not found`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  return profile;
}
