import { Command } from 'commander';
import { getProfileStatuses, type ProfileStatus } from './status';
import { getCredentials, setCredentials } from '../auth/token-store';
import { interactiveCheckbox } from '../utils/interactive';
import { handleError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import { findServicePlugin } from '../plugins/registry';
import { reauthGoogleGroups, type GoogleGrantDeps } from '../plugins/google/group';
import { createSetupContext } from '../plugins/host-context';
import { isDeclarativePlugin } from '../plugins/types';

export async function reauthProfile(service: ServiceName, profileName: string): Promise<void> {
  const plugin = findServicePlugin(service);
  const pluginReauthenticate = plugin?.profile?.reauthenticate;
  if (pluginReauthenticate) {
    const existing = await getCredentials<Record<string, unknown>>(service, profileName);
    let replacement: Record<string, unknown>;
    if (plugin && isDeclarativePlugin(plugin)) {
      replacement = await plugin.profile!.reauthenticate!(existing, profileName, createSetupContext());
    } else if (plugin) {
      replacement = await plugin.profile!.reauthenticate!(existing, profileName);
    } else {
      return;
    }
    await setCredentials(service, profileName, replacement);
    return;
  }

  console.error(`\nSkipping ${service} / ${profileName}: no automatic reauthentication is registered. Run 'agentio ${service} profile add --profile ${profileName}' to update.`);
}

/** Renew the chosen profiles: Google ones of one account together, then the rest one at a time. */
export async function reauthSelected(selected: ProfileStatus[], googleDeps: GoogleGrantDeps = {}): Promise<void> {
  const remaining = await reauthGoogleGroups(selected, googleDeps);
  for (const s of remaining) {
    try {
      await reauthProfile(s.service, s.profile);
    } catch (error) {
      console.error(
        `\n  Failed to reauth ${s.service} / ${s.profile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
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

        await reauthSelected(selected);

        console.log('\nDone.');
      } catch (error) {
        handleError(error);
      }
    });
}
