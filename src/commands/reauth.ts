import { Command } from 'commander';
import { getProfileStatuses, type ProfileStatus } from './status';
import { getCredentials, setCredentials } from '../auth/token-store';
import { interactiveCheckbox } from '../utils/interactive';
import { handleError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import { findServicePlugin } from '../plugins/registry';

export async function reauthProfile(service: ServiceName, profileName: string): Promise<void> {
  const pluginReauthenticate = findServicePlugin(service)?.profile?.reauthenticate;
  if (pluginReauthenticate) {
    const existing = await getCredentials<Record<string, unknown>>(service, profileName);
    const replacement = await pluginReauthenticate(existing, profileName);
    await setCredentials(service, profileName, replacement);
    return;
  }

  console.error(`\nSkipping ${service} / ${profileName}: no automatic reauthentication is registered. Run 'agentio ${service} profile add --profile ${profileName}' to update.`);
}

export function registerReauthCommand(program: Command): void {
  program
    .command('reauth', { hidden: true })
    .description('Re-authenticate expired or invalid profiles')
    .option('--all', 'Re-authenticate all invalid profiles without prompting')
    .action(async (options) => {
      try {
        console.error('Checking profile credentials...\n');

        const statuses = await getProfileStatuses();
        const invalid = statuses.filter(
          (s) => s.status === 'invalid' || s.status === 'no-creds'
        );

        if (invalid.length === 0) {
          console.log('All profiles are valid.');
          return;
        }

        let selected: ProfileStatus[];

        if (options.all) {
          selected = invalid;
        } else {
          const choices = invalid.map((s) => ({
            name: `${s.service} / ${s.profile} (${s.error || 'no credentials'})`,
            value: s,
            checked: true,
          }));

          selected = await interactiveCheckbox({
            message: 'Select profiles to re-authenticate:',
            choices,
            required: true,
          });
        }

        for (const s of selected) {
          try {
            await reauthProfile(s.service, s.profile);
          } catch (error) {
            console.error(
              `\n  Failed to reauth ${s.service} / ${s.profile}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        console.log('\nDone.');
      } catch (error) {
        handleError(error);
      }
    });
}
