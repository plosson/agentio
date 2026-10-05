import { Command } from 'commander';
import { requireProfile } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { promptHidden, readStdinRaw } from '../../utils/stdin';
import { addProfileWithSetup } from '../profile-host';
import type { SetupResult } from '../../plugin-sdk';
import type { ProfileAddOptions } from '../types';
import { printSecrets } from './output';
import { loadSecrets, missingKeyError, SERVICE, updateSecrets, validateKey } from './store';
import type { SecretsCredentials } from './types';

const PROFILE_OPTION = 'Profile name (optional if only one profile exists)';

/** A new profile holds nothing; values come from `set` and `import`. */
export async function secretsProfileAdd(_options: ProfileAddOptions): Promise<SetupResult<SecretsCredentials>> {
  return { credentials: { values: {} }, suggestedProfileName: 'default', info: 'Add secrets with: agentio secrets set <KEY>' };
}

/** A value from stdin (one trailing newline dropped), or typed without echo in a terminal. */
async function readValue(key: string): Promise<string> {
  const value = process.stdin.isTTY
    ? await promptHidden(`? Value for ${key}: `)
    : (await readStdinRaw())?.replace(/\r?\n$/, '');
  if (!value) {
    throw new CliError('INVALID_PARAMS', `No value given for ${key}`, 'Pass it after the name, pipe it on stdin, or type it when asked');
  }
  return value;
}

export function registerSecretsCommands(program: Command): Command {
  const secrets = program.command('secrets').description('Store secrets by name, and run commands with them as environment variables');

  addExamples(
    secrets
      .command('set')
      .description('Add or replace one secret')
      .argument('<key>', 'Secret name, also its environment variable name in exec')
      .argument('[value]', 'Value (default: read from stdin, or asked for without echo)')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (key: string, value: string | undefined, options: { profile?: string }) => {
        try {
          validateKey(key);
          const profile = await requireProfile(SERVICE, options.profile);
          await enforceWriteAccess(SERVICE, profile, 'set a secret');
          const secret = value ?? (await readValue(key));
          const replaced = await updateSecrets(profile, (values) => {
            const had = values.has(key);
            values.set(key, secret);
            return had;
          });
          console.error(`${replaced ? 'Replaced' : 'Added'} ${key} in profile "${profile}"`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # asks for the value without showing it, so it stays out of shell history
  agentio secrets set SMTP_PASSWORD --profile smtp

  printf %s "$TOKEN" | agentio secrets set API_TOKEN --profile ci
  agentio secrets set SMTP_HOST mail.example.com --profile smtp`,
  );

  addExamples(
    secrets
      .command('get')
      .description('Print one secret\'s value, with no added newline')
      .argument('<key>', 'Secret name')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (key: string, options: { profile?: string }) => {
        try {
          const profile = await requireProfile(SERVICE, options.profile);
          const values = await loadSecrets(profile);
          const value = values.get(key);
          if (value === undefined) throw missingKeyError(profile, key, values);
          process.stdout.write(value);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  curl -u "me:$(agentio secrets get SMTP_PASSWORD --profile smtp)" ...`,
  );

  addExamples(
    addJsonOption(
      secrets
        .command('list')
        .description('List secret names; --reveal adds the values')
        .option('--reveal', 'Show values too')
        .option('--profile <name>', PROFILE_OPTION),
    ).action(async (options: { profile?: string; reveal?: boolean; json?: boolean }) => {
      try {
        const profile = await requireProfile(SERVICE, options.profile);
        printSecrets(await loadSecrets(profile), { reveal: !!options.reveal, json: options.json });
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio secrets list --profile smtp
  agentio secrets list --profile smtp --reveal --json`,
  );

  addExamples(
    secrets
      .command('unset')
      .description('Remove one secret')
      .argument('<key>', 'Secret name')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (key: string, options: { profile?: string }) => {
        try {
          const profile = await requireProfile(SERVICE, options.profile);
          await enforceWriteAccess(SERVICE, profile, 'remove a secret');
          await updateSecrets(profile, (values) => {
            if (!values.delete(key)) throw missingKeyError(profile, key, values);
          });
          console.error(`Removed ${key} from profile "${profile}"`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio secrets unset SMTP_PASSWORD --profile smtp`,
  );

  const profile = createProfileCommands<SecretsCredentials>(secrets, {
    service: SERVICE,
    displayName: 'Secrets',
  });

  addExamples(
    profile
      .command('add')
      .description('Add an empty secrets profile')
      .option('--profile <name>', 'Profile name (default: default)')
      .option('--read-only', 'Create as read-only profile (blocks set, unset and import)')
      .action(async (options: ProfileAddOptions) => {
        try {
          await addProfileWithSetup(SERVICE, secretsProfileAdd, options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio secrets profile add --profile smtp`,
  );

  return secrets;
}
