import { stat } from 'fs/promises';
import { Command } from 'commander';
import { requireProfile } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { promptHidden, readStdinRaw } from '../../utils/stdin';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import type { SetupResult } from '../../plugin-sdk';
import type { ProfileAddOptions } from '../types';
import { parseDotenv } from './dotenv';
import { runWithSecrets } from './exec';
import { printSecrets } from './output';
import { loadSecrets, missingKeyError, SERVICE, updateSecrets, validateKey } from './store';
import type { SecretsCredentials } from './types';

const PROFILE_OPTION = 'Profile name (optional if only one profile exists)';

/** A new profile holds nothing; values come from `set` and `import`. */
export async function secretsProfileAdd(): Promise<SetupResult<SecretsCredentials>> {
  return { credentials: { values: {} }, suggestedProfileName: 'default', info: 'Add secrets with: agentio secrets set <KEY>' };
}

/** The profile a write command runs against, refused when it is read-only. */
async function writableProfile(name: string | undefined, operation: string): Promise<string> {
  const profile = await requireProfile(SERVICE, name);
  await enforceWriteAccess(SERVICE, profile, operation);
  return profile;
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
          const profile = await writableProfile(options.profile, 'set a secret');
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
          const profile = await writableProfile(options.profile, 'remove a secret');
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

  addExamples(
    secrets
      .command('import')
      .description('Load secrets from a dotenv file; existing names are replaced')
      .argument('<file>', 'A dotenv file: KEY=value lines')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (file: string, options: { profile?: string }) => {
        try {
          const profile = await writableProfile(options.profile, 'import secrets');
          const info = await stat(file).catch(() => null);
          if (!info?.isFile()) throw new CliError('NOT_FOUND', `No file at ${file}`, 'Give the path to a dotenv file');
          const entries = parseDotenv(await Bun.file(file).text());
          const { added, replaced } = await updateSecrets(profile, (values) => {
            let added = 0;
            let replaced = 0;
            for (const [key, value] of entries) {
              if (values.has(key)) replaced++;
              else added++;
              values.set(key, value);
            }
            return { added, replaced };
          });
          console.error(`Imported into profile "${profile}": ${added} added, ${replaced} replaced`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio secrets import .env --profile app`,
  );

  addExamples(
    secrets
      .command('exec')
      .description('Run a command with the profile\'s secrets as environment variables')
      .argument('[command...]', 'The command and its arguments, after --')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (command: string[], options: { profile?: string }) => {
        try {
          if (command.length === 0) {
            throw new CliError('INVALID_PARAMS', 'No command to run', 'Usage: agentio secrets exec --profile <name> -- <command> [args...]');
          }
          const profile = await requireProfile(SERVICE, options.profile);
          process.exit(await runWithSecrets(command, await loadSecrets(profile)));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # the script reads SMTP_HOST and SMTP_PASSWORD; the agent never sees them
  agentio secrets exec --profile smtp -- ./send-mail.sh

  agentio secrets exec --profile app -- bun run migrate`,
  );

  const profile = createProfileCommands<SecretsCredentials>(secrets, {
    service: SERVICE,
    displayName: 'Secrets',
  });

  addExamples(
    addSetupOptions(
      profile
        .command('add')
        .description('Add an empty secrets profile')
        .option('--profile <name>', 'Profile name (default: default)')
        .option('--read-only', 'Create as read-only profile (blocks set, unset and import)')
    )
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
