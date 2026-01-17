import { Command } from 'commander';
import { listProfiles, removeProfile, setDefault } from '../config/config-manager';
import { removeCredentials, getCredentials } from '../auth/token-store';
import { handleError, CliError } from './errors';
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
        const { profiles, default: defaultProfile } = result[0];

        if (profiles.length === 0) {
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials<T>(service, name);
            const extraInfo = getExtraInfo ? getExtraInfo(credentials) : '';
            console.log(`${name}${marker}${extraInfo}`);
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

  profile
    .command('default')
    .description(`Set the default ${displayName} profile`)
    .argument('<name>', 'Profile name to set as default')
    .action(async (name) => {
      try {
        const success = await setDefault(service, name);

        if (success) {
          console.log(`Default profile set to "${name}"`);
        } else {
          throw new CliError(
            'PROFILE_NOT_FOUND',
            `Profile "${name}" not found`,
            `Run: agentio ${service} profile list`
          );
        }
      } catch (error) {
        handleError(error);
      }
    });

  return profile;
}
