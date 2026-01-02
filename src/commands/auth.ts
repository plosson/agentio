import { Command } from 'commander';
import { setProfile, removeProfile, listProfiles } from '../config/config-manager';
import { setTokens, removeTokens } from '../auth/token-store';
import { performOAuthFlow } from '../auth/oauth';
import { getValidTokens } from '../auth/token-manager';
import { CliError, handleError } from '../utils/errors';
import type { ServiceName } from '../types/config';

const VALID_SERVICES: ServiceName[] = ['gmail', 'gchat', 'jira'];

function validateService(service: string): ServiceName {
  if (!VALID_SERVICES.includes(service as ServiceName)) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid service: ${service}`,
      `Valid services: ${VALID_SERVICES.join(', ')}`
    );
  }
  return service as ServiceName;
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('Manage authentication');

  auth
    .command('setup <service>')
    .description('Set up authentication for a service')
    .option('--profile <name>', 'Profile name', 'default')
    .action(async (service: string, options) => {
      try {
        const svc = validateService(service);
        const { profile } = options;

        if (svc === 'jira') {
          throw new CliError('INVALID_PARAMS', 'Jira is not yet supported');
        }

        if (svc === 'gchat') {
          throw new CliError('INVALID_PARAMS', 'Google Chat is not yet supported');
        }

        console.error(`Starting OAuth flow for ${svc} profile "${profile}"...`);

        // Perform OAuth flow
        const tokens = await performOAuthFlow(svc);

        // Save profile and tokens
        await setProfile(svc, profile);
        await setTokens(svc, profile, tokens);

        console.error(`\nSuccess! Profile "${profile}" for ${svc} is now configured.`);
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command('list [service]')
    .description('List configured profiles')
    .action(async (service?: string) => {
      try {
        const svc = service ? validateService(service) : undefined;
        const profiles = await listProfiles(svc);

        for (const { service: s, profiles: p, default: d } of profiles) {
          if (p.length === 0) {
            console.log(`${s}: (no profiles)`);
          } else {
            const items = p.map((name) => name === d ? `${name} (default)` : name);
            console.log(`${s}: ${items.join(', ')}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command('remove <service>')
    .description('Remove a profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (service: string, options) => {
      try {
        const svc = validateService(service);
        const { profile } = options;

        const removed = await removeProfile(svc, profile);
        await removeTokens(svc, profile);

        if (removed) {
          console.error(`Removed profile "${profile}" for ${svc}`);
        } else {
          console.error(`Profile "${profile}" not found for ${svc}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command('test <service>')
    .description('Test authentication for a profile')
    .option('--profile <name>', 'Profile name (uses default if not specified)')
    .action(async (service: string, options) => {
      try {
        const svc = validateService(service);

        const { tokens, profile } = await getValidTokens(svc, options.profile);

        console.error(`Authentication successful for ${svc} profile "${profile}"`);
        console.error(`Token expires: ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'unknown'}`);
      } catch (error) {
        handleError(error);
      }
    });
}
