import { Command } from 'commander';
import { handleError, CliError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
  type ApiKeyView,
} from '../auth/api-keys';
import type { ApiKeyScope } from '../types/config';

function scopeFromOptions(opts: { profiles?: string; all?: boolean }): ApiKeyScope | undefined {
  if (opts.all && opts.profiles) {
    throw new CliError('INVALID_PARAMS', '--all and --profiles are mutually exclusive');
  }
  if (opts.all) return '*';
  if (opts.profiles) return opts.profiles.split(',').map((s) => s.trim()).filter(Boolean);
  return undefined;
}

function scopeSummary(key: ApiKeyView): string {
  return key.allowedProfiles === '*' ? 'all profiles' : key.allowedProfiles.join(', ');
}

/** The token goes to stdout alone so it can be captured; everything else to stderr. */
function printIssued(token: string, key: ApiKeyView): void {
  console.error(`Key "${key.name}" (${key.id}), ${scopeSummary(key)}${key.readOnly ? ', read-only' : ''}`);
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
      .action(async (name: string, opts) => {
        try {
          const scope = scopeFromOptions(opts);
          if (!scope) throw new CliError('INVALID_PARAMS', 'Choose a scope', 'Pass --all or --profiles <service/name,...>');
          const issued = await createApiKey({ name, allowedProfiles: scope, readOnly: opts.readOnly }, opts.url);
          printIssued(issued.token, issued.key);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # a key for one agent, limited to two profiles
  agentio key create claudiu --url https://vault.example.com --profiles gdrive/docunit,gmail/work

  # everything, but read-only
  agentio key create reporter --url https://vault.example.com --all --read-only

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
            const flags = k.readOnly ? ' [read-only]' : '';
            const used = k.lastUsedAt ? `last used ${k.lastUsedAt}` : 'never used';
            console.log(`${k.id}  ${k.name}${flags}  ${scopeSummary(k)}  created ${k.createdAt}  ${used}`);
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
      .action(async (id: string, opts) => {
        try {
          const scope = scopeFromOptions(opts);
          if (opts.name === undefined && scope === undefined && opts.readOnly === undefined) {
            throw new CliError('INVALID_PARAMS', 'Nothing to update', 'Pass --name, --profiles/--all, or --read-only/--no-read-only');
          }
          const updated = await updateApiKey(id, { name: opts.name, allowedProfiles: scope, readOnly: opts.readOnly });
          if (!updated) throw new CliError('NOT_FOUND', `No key with id ${id}`);
          console.log(`Updated "${updated.name}" (${updated.id}): ${scopeSummary(updated)}${updated.readOnly ? ', read-only' : ''}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio key update a1b2c3d4 --profiles gdrive/docunit
  agentio key update a1b2c3d4 --no-read-only`,
  );

  addExamples(
    key
      .command('rotate')
      .description('Replace the secret; the old token stops working at once')
      .argument('<id>', 'Key id from `agentio key list`')
      .requiredOption('--url <url>', 'Public base URL of this hub, embedded in the new token')
      .action(async (id: string, opts) => {
        try {
          const issued = await rotateApiKey(id, opts.url);
          if (!issued) throw new CliError('NOT_FOUND', `No key with id ${id}`);
          printIssued(issued.token, issued.key);
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
          if (!(await revokeApiKey(id))) throw new CliError('NOT_FOUND', `No key with id ${id}`);
          console.log(`Revoked ${id}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio key revoke a1b2c3d4`,
  );
}
