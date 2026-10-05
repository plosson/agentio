import { Command } from 'commander';
import { getProfileStatuses, type ProfileStatus } from './status';
import { getCredentials } from '../auth/token-store';
import { interactiveCheckbox } from '../utils/interactive';
import { CliError, handleError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import { findServicePlugin } from '../plugins/registry';
import { createJsonSetupContext, createSetupContext } from '../plugins/host-context';
import { saveProfile } from '../config/profile-store';
import { isRemoteMode } from '../auth/remote';
import { isJsonMode, printJson } from '../utils/output';
import { createLineReader } from '../utils/line-reader';
import type { SetupContext } from '../plugin-sdk';

function cannotReauthAsJson(service: string, profileName: string): CliError {
  return new CliError(
    'INVALID_PARAMS',
    `${service} cannot be signed in again with --json yet`,
    `Run: agentio profile reauth ${service} ${profileName}`,
  );
}

/**
 * A remote reauth starts from the hub's redacted credentials and replaces them whole, so it is safe
 * only for a plugin whose sign-in issues every secret afresh: those that declare `needs`.
 */
function cannotReauthRemotely(service: string, profileName: string): CliError {
  return new CliError(
    'INVALID_PARAMS',
    `${service} cannot be signed in again from this machine yet`,
    `Run on the hub: agentio profile reauth ${service} ${profileName}`,
  );
}

/**
 * Sign a profile in again and replace its credentials under the same name, locally or on the hub,
 * keeping its read-only flag; PROFILE_NOT_FOUND when it was deleted meanwhile. `context` defaults to the terminal; in JSON mode the sign-in runs for
 * a program (events on stdout, answers on stdin) and ends with a `reauthed` event.
 */
export async function reauthProfile(service: ServiceName, profileName: string, context?: SetupContext): Promise<void> {
  const profile = findServicePlugin(service)?.profile;
  const json = !context && isJsonMode();
  if (isRemoteMode() && !profile?.needs) throw cannotReauthRemotely(service, profileName);
  if (json && !(profile?.needs && profile.reauthenticate)) throw cannotReauthAsJson(service, profileName);
  if (!profile?.reauthenticate) {
    console.error(`\nSkipping ${service} / ${profileName}: no automatic reauthentication is registered. Run 'agentio ${service} profile add --profile ${profileName}' to update.`);
    return;
  }

  const lines = json ? createLineReader(process.stdin) : undefined;
  try {
    // As stored: a hub would otherwise refresh them first, and a dead refresh token is why we are here.
    // Strict, so a hub that cannot hand them out says why instead of the sign-in starting from nothing.
    const existing = await getCredentials<Record<string, unknown>>(service, profileName, { strict: true, refresh: false });
    const setup = context ?? (lines ? createJsonSetupContext({}, lines) : createSetupContext());
    const replacement = await profile.reauthenticate(existing, profileName, setup);
    // Replace only: a profile deleted while the sign-in ran stays deleted.
    await saveProfile(service, profileName, replacement, { replaceOnly: true });
    if (json) printJson({ event: 'reauthed', service, profile: profileName });
  } finally {
    if (lines) {
      // Stop reading stdin, so the process exits once the profile is saved.
      lines.close();
      process.stdin.pause();
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
