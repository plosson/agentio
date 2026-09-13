import { Command } from 'commander';
import { handleError, CliError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
  describeScope,
  type ApiKeyInput,
  type IssuedKey,
} from '../auth/api-keys';
import type { ApiKeyScope } from '../types/config';

type KeyOptions = { name?: string; profiles?: string; all?: boolean; readOnly?: boolean; canAddProfiles?: boolean };

function scopeFromOptions(opts: KeyOptions): ApiKeyScope | undefined {
  if (opts.all && opts.profiles) {
    throw new CliError('INVALID_PARAMS', '--all and --profiles are mutually exclusive');
  }
  if (opts.all) return '*';
  if (opts.profiles) return opts.profiles.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

/** The options as createApiKey and updateApiKey take them; an option not given stays undefined. */
function keyInputFromOptions(opts: KeyOptions): ApiKeyInput {
  return { name: opts.name, allowedProfiles: scopeFromOptions(opts), readOnly: opts.readOnly, canAddProfiles: opts.canAddProfiles };
}

/** The token goes to stdout alone so it can be captured; everything else to stderr. */
function printIssued({ key, token }: IssuedKey): void {
  console.error(`Key "${key.name}" (${key.id}), ${describeScope(key)}`);
  console.error('This token is shown once. Set it on the agent machine as AGENTIO_TOKEN.');
  console.log(token);
}

export function registerKeyCommands(program: Command): void {
  const key = program
    .command('key')
    .description('API keys that let remote agents read credentials from this vault');

  addExamples(
    key
      .command('create')
      .description('Create a key and print its token once')
      .argument('<name>', 'Display name, e.g. the agent or machine it is for')
      .requiredOption('--url <url>', 'Public base URL of this hub, embedded in the token')
      .option('--profiles <list>', 'Comma-separated service/name pairs the key may use')
      .option('--all', 'Allow every profile')
      .option('--read-only', 'Force read-only on every profile the key can see', false)
      .option('--can-add-profiles', 'Let the agent add profiles to this vault from its machine', false)
      .action(async (name: string, opts) => {
        try {
          const input = { ...keyInputFromOptions(opts), name };
          if (!input.allowedProfiles) throw new CliError('INVALID_PARAMS', 'Choose a scope', 'Pass --all or --profiles <service/name,...>');
          printIssued(await createApiKey(input, opts.url));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # a key for one agent, limited to two profiles
  agentio key create claudiu --url https://vault.example.com --profiles gdrive/docunit,gmail/work

  # everything, but read-only
  agentio key create reporter --url https://vault.example.com --all --read-only

  # a laptop that can add its own profiles to the vault
  agentio key create laptop --url https://vault.example.com --all --can-add-profiles

  # capture the token for a deploy script
  AGENTIO_TOKEN=$(agentio key create ci --url https://vault.example.com --all)`,
  );

  addExamples(
    key
      .command('list')
      .description('List keys (never the secrets)')
      .action(async () => {
        try {
          const keys = await listApiKeys();
          if (keys.length === 0) {
            console.log('No API keys. Create one with: agentio key create <name> --url <hub-url> --all');
            return;
          }
          for (const k of keys) {
            const used = k.lastUsedAt ? `last used ${k.lastUsedAt}` : 'never used';
            console.log(`${k.id}  ${k.name}  agio1.…${k.hint ?? ''}  ${describeScope(k)}  created ${k.createdAt}  ${used}`);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio key list`,
  );

  addExamples(
    key
      .command('update')
      .description('Rename a key or change its scope')
      .argument('<id>', 'Key id from `agentio key list`')
      .option('--name <name>', 'New display name')
      .option('--profiles <list>', 'Comma-separated service/name pairs the key may use')
      .option('--all', 'Allow every profile')
      .option('--read-only', 'Force read-only')
      .option('--no-read-only', 'Lift the key-level read-only restriction')
      .option('--can-add-profiles', 'Let the agent add profiles to this vault from its machine')
      .option('--no-can-add-profiles', 'Stop the agent from adding profiles')
      .action(async (id: string, opts) => {
        try {
          const patch = keyInputFromOptions(opts);
          if (Object.values(patch).every((v) => v === undefined)) {
            throw new CliError('INVALID_PARAMS', 'Nothing to update', 'Pass at least one option; see --help');
          }
          const updated = await updateApiKey(id, patch);
          console.log(`Updated "${updated.name}" (${updated.id}): ${describeScope(updated)}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio key update a1b2c3d4 --profiles gdrive/docunit
  agentio key update a1b2c3d4 --no-read-only
  agentio key update a1b2c3d4 --can-add-profiles`,
  );

  addExamples(
    key
      .command('rotate')
      .description('Replace the secret; the old token stops working at once')
      .argument('<id>', 'Key id from `agentio key list`')
      .requiredOption('--url <url>', 'Public base URL of this hub, embedded in the new token')
      .action(async (id: string, opts) => {
        try {
          printIssued(await rotateApiKey(id, opts.url));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio key rotate a1b2c3d4 --url https://vault.example.com`,
  );

  addExamples(
    key
      .command('revoke')
      .description('Delete a key; its token stops working at once')
      .argument('<id>', 'Key id from `agentio key list`')
      .action(async (id: string) => {
        try {
          await revokeApiKey(id);
          console.log(`Revoked ${id}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio key revoke a1b2c3d4`,
  );
}
