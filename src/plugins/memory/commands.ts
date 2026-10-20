import { Command } from 'commander';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { confirm, readStdin } from '../../utils/stdin';
import { addProfileWithSetup } from '../profile-host';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import { checkAnswer } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import {
  DEFAULT_SCAN,
  MAX_EPISODES,
  MAX_FACTS,
  MemoryClient,
  normaliseMemoryUrl,
  parseCount,
  parseDocumentUrl,
  parseGroup,
} from './client';
import { entityFacts, listEpisodes, planForget, runForget, withSources } from './operations';
import { describePlan, printAdded, printEntity, printEpisodes, printFacts, printForgot } from './output';
import type { MemoryCredentials } from './types';

/** The environment variable `profile add` reads the bearer token from, so it never has to be typed on a command line. */
export const MEMORY_TOKEN_ENV = 'AGENTIO_MEMORY_TOKEN';

export const MEMORY_URL_INPUT: InputSpec = { label: 'Graphiti server URL', kind: 'url', help: 'For example https://graphiti.example.com' };
const MEMORY_TOKEN_INPUT: InputSpec = { label: 'Bearer token', kind: 'secret', help: 'The token the proxy in front of the Graphiti server checks' };
const MEMORY_GROUP_INPUT: InputSpec = {
  label: 'Default group',
  kind: 'text',
  required: false,
  help: 'The namespace used when a command has no --group, such as famille; leave empty for none',
};

const getMemoryClient = createClientGetter<MemoryCredentials, MemoryClient>({
  service: 'memory',
  createClient: (credentials) => new MemoryClient(credentials),
});

async function getWritableClient(profileName: string | undefined, operation: string): Promise<MemoryClient> {
  const { client, profile } = await getMemoryClient(profileName);
  await enforceWriteAccess('memory', profile, operation);
  return client;
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** A leaf command with the options every memory command takes. */
function leaf(parent: Command, name: string, description: string): Command {
  return addJsonOption(
    parent
      .command(name)
      .description(description)
      .option('--profile <name>', 'Profile name, one per Graphiti server (optional if only one profile exists)'),
  );
}

/**
 * Run a command's action with its options read through `optsWithGlobals()`, so an option that a parent
 * command also declares (Commander gives it to the parent) still reaches the subcommand.
 */
function run(action: (args: string[], options: Record<string, any>) => Promise<void>) {
  return async (...received: unknown[]) => {
    const command = received[received.length - 1] as Command;
    const args = received.slice(0, -2) as string[];
    try {
      await action(args, command.optsWithGlobals());
    } catch (error) {
      handleError(error);
    }
  };
}

function optionalText(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new CliError('INVALID_PARAMS', `${option} cannot be empty`);
  return value.trim();
}

function parseTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!value.trim() || Number.isNaN(date.getTime())) {
    throw new CliError('INVALID_PARAMS', `--time must be a date or an ISO 8601 time, not "${value}"`, 'For example: --time 2026-03-14 or --time 2026-03-14T09:30:00Z');
  }
  return date.toISOString();
}

/** The text to remember: `--text`, `--text -` for stdin, or stdin when `--text` is absent and something is piped. */
async function readText(text: string | undefined): Promise<string> {
  if (text !== undefined && text !== '-') {
    if (!text.trim()) throw new CliError('INVALID_PARAMS', '--text cannot be empty');
    return text;
  }
  const piped = await readStdin();
  if (!piped) throw new CliError('INVALID_PARAMS', 'Nothing to remember', 'Pass --text "...", or pipe the text on stdin');
  return piped;
}

export interface MemoryProfileAddOptions extends ProfileAddOptions {
  url?: string;
  /** From `--token-stdin` or AGENTIO_MEMORY_TOKEN; never a command-line flag. */
  token?: string;
  group?: string;
}

/** The profile name a server suggests: the host's first label, or the whole host for an IP address. */
export function suggestedName(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return host;
  return host.split('.')[0];
}

/**
 * Setup: the server URL, the bearer token and an optional default group. The URL is a profile value, never a
 * built-in one: each profile is one Graphiti server. The default group is asked only in a fully interactive
 * setup (no `--url` either), so a scripted `profile add` never waits on a question it did not need.
 */
export async function memoryProfileAdd(
  options: MemoryProfileAddOptions,
  context: SetupContext,
): Promise<SetupResult<MemoryCredentials>> {
  const interactive = options.url === undefined;
  const baseUrl = normaliseMemoryUrl(options.url !== undefined ? checkAnswer(MEMORY_URL_INPUT, options.url) : await context.ask(MEMORY_URL_INPUT));
  const token = options.token !== undefined ? checkAnswer(MEMORY_TOKEN_INPUT, options.token) : await context.ask(MEMORY_TOKEN_INPUT);
  let group = options.group !== undefined ? parseGroup(options.group) : undefined;
  if (group === undefined && interactive) {
    const answer = await context.ask(MEMORY_GROUP_INPUT);
    group = answer ? parseGroup(answer, 'The default group') : undefined;
  }

  const credentials: MemoryCredentials = { baseUrl, token, ...(group ? { defaultGroup: group } : {}) };
  const client = new MemoryClient(credentials);
  await client.health();
  let info = `Connected to Graphiti at ${new URL(baseUrl).host}`;
  if (group) {
    try {
      const episodes = await client.episodes(group, 1);
      info += `, default group ${group}${episodes.length ? '' : ' (empty so far)'}`;
    } catch (error) {
      if (error instanceof CliError && error.code === 'AUTH_FAILED') throw error;
      const reason = error instanceof Error ? error.message : String(error);
      context.log(`Warning: the server answers, but listing group ${group} failed: ${reason}`);
    }
  }
  return { credentials, suggestedProfileName: suggestedName(baseUrl), info };
}

export function registerMemoryCommands(program: Command): void {
  const memory = program
    .command('memory')
    .description('Remember facts linked to a document, and search them, in a Graphiti knowledge graph');

  addExamples(
    leaf(memory, 'add', 'Remember text from a document: one Graphiti episode, traced back to the document by --ref')
      .requiredOption('--ref <id>', 'Id of the document the text comes from, such as a Google Drive file id')
      .option('--url <link>', 'Link to the document')
      .option('--text <text>', 'The text or facts to remember; - (or no --text) reads stdin')
      .option('--group <id>', 'Group (namespace) to store it in (default: the profile\'s default group)')
      .option('--name <name>', 'Episode name (default: ref:<id>)')
      .option('--time <when>', 'When the facts were true or the document was written, ISO 8601 (default: now)')
      .action(run(async (_args, options) => {
        const ref = optionalText(options.ref, '--ref')!;
        const url = options.url !== undefined ? parseDocumentUrl(options.url) : undefined;
        const name = optionalText(options.name, '--name');
        const time = parseTime(options.time);
        const client = await getWritableClient(options.profile, 'add to memory');
        const group = client.group(options.group);
        const text = await readText(options.text);
        printAdded(await client.add({ group, ref, url, text, name, time }), options.json);
      })),
    `Examples:

  agentio memory add --ref 1AbCdEfGhIjK --url https://docs.google.com/document/d/1AbCdEfGhIjK \\
    --text "Marie starts at the Lyon office on 3 March." --group famille

  # the text from another command
  some-command | agentio memory add --ref invoice-2026-014 --group societes --json

The server answers at once and extracts facts in the background, so they
reach search a little later. The ref and url are stored in the episode's
source_description as "ref:<id> url:<url>" (the id percent-encoded).`,
  );

  addExamples(
    leaf(memory, 'search', 'Search facts, each with the documents (ref, url) it came from')
      .argument('<query>', 'What to look for, in plain words')
      .option('--group <id>', 'Group to search; repeat for several (default: the profile\'s default group, else all)', collect)
      .option('--limit <n>', `Most facts to return, 1 to ${MAX_FACTS}`, '10')
      .option('--scan <n>', `Recent episodes read per group to find each fact's document, 1 to ${MAX_EPISODES}`, String(DEFAULT_SCAN))
      .action(run(async ([query], options) => {
        if (!query?.trim()) throw new CliError('INVALID_PARAMS', 'A search query is required');
        const limit = parseCount(options.limit, '--limit', MAX_FACTS);
        const scan = parseCount(options.scan, '--scan', MAX_EPISODES);
        const { client } = await getMemoryClient(options.profile);
        const groups = client.groups(options.group);
        const facts = await client.search(query, groups, limit);
        printFacts(await withSources(client, facts, groups, scan), options.json);
      })),
    `Examples:

  agentio memory search "where does Marie work" --group famille

  # several groups at once
  agentio memory search "bank accounts" --group famille --group societes --limit 20 --json

Without any group (no --group and no default group) every group is
searched, but the documents behind the facts cannot be resolved: sources
then show the episode uuid only.`,
  );

  addExamples(
    leaf(memory, 'entity', 'Facts linked to one entity (a person, company, place...)')
      .argument('<name>', 'Entity name, as it appears in the facts')
      .option('--group <id>', 'Group to look in (default: the profile\'s default group)')
      .option('--limit <n>', `Most facts to return, 1 to ${MAX_FACTS}`, '20')
      .option('--scan <n>', `Recent episodes read to find each fact's document, 1 to ${MAX_EPISODES}`, String(DEFAULT_SCAN))
      .action(run(async ([name], options) => {
        if (!name?.trim()) throw new CliError('INVALID_PARAMS', 'An entity name is required');
        const limit = parseCount(options.limit, '--limit', MAX_FACTS);
        const scan = parseCount(options.scan, '--scan', MAX_EPISODES);
        const { client } = await getMemoryClient(options.profile);
        printEntity(await entityFacts(client, name, client.group(options.group), limit, scan), options.json);
      })),
    `Examples:

  agentio memory entity "Marie" --group famille

  agentio memory entity "Acme SA" --group societes --json

The REST server cannot look an entity up by name, so this searches for
the name, takes the graph node the matching facts share, and returns the
facts around that node.`,
  );

  addExamples(
    leaf(memory, 'episodes', 'List the most recent episodes of a group, optionally for one document')
      .option('--ref <id>', 'Only episodes from this document')
      .option('--group <id>', 'Group to list (default: the profile\'s default group)')
      .option('--limit <n>', `Most episodes to return, 1 to ${MAX_EPISODES}`, '20')
      .option('--scan <n>', `With --ref: recent episodes read to find it, 1 to ${MAX_EPISODES}`, String(DEFAULT_SCAN))
      .action(run(async (_args, options) => {
        const limit = parseCount(options.limit, '--limit', MAX_EPISODES);
        const scan = parseCount(options.scan, '--scan', MAX_EPISODES);
        const ref = optionalText(options.ref, '--ref');
        const { client } = await getMemoryClient(options.profile);
        printEpisodes(await listEpisodes(client, client.group(options.group), limit, ref, scan), options.json);
      })),
    `Examples:

  agentio memory episodes --group famille --limit 50

  agentio memory episodes --ref 1AbCdEfGhIjK --group famille --json`,
  );

  addExamples(
    leaf(memory, 'forget', 'Delete every episode from one document, and the facts that came only from them')
      .requiredOption('--ref <id>', 'Id of the document to forget')
      .option('--group <id>', 'Group to forget it in (default: the profile\'s default group)')
      .option('--scan <n>', `Recent episodes read to find the ref, 1 to ${MAX_EPISODES}`, String(DEFAULT_SCAN))
      .option('--keep-facts', 'Delete the episodes only, and leave the facts extracted from them')
      .option('-y, --yes', 'Do not ask for confirmation')
      .action(run(async (_args, options) => {
        const ref = optionalText(options.ref, '--ref')!;
        const scan = parseCount(options.scan, '--scan', MAX_EPISODES);
        const client = await getWritableClient(options.profile, 'forget a document');
        const group = client.group(options.group);
        const plan = await planForget(client, ref, group, scan, options.keepFacts === true);
        if (plan.episodes.length > 0 && !options.yes) {
          if (!process.stdin.isTTY) {
            throw new CliError('INVALID_PARAMS', `${describePlan(plan)} Not confirmed`, 'Pass --yes to forget without a question');
          }
          if (!(await confirm(describePlan(plan)))) {
            console.error('Cancelled');
            return;
          }
        }
        const result = await runForget(client, plan);
        printForgot(result, options.json);
        if (result.failed.length) {
          throw new CliError('API_ERROR', `${result.failed.length} deletion${result.failed.length === 1 ? '' : 's'} failed`, 'Run the same command again to retry');
        }
      })),
    `Examples:

  agentio memory forget --ref 1AbCdEfGhIjK --group famille

  # in a script
  agentio memory forget --ref invoice-2026-014 --group societes --yes --json

Facts that other documents also support are kept. Entity nodes stay: the
Graphiti REST server has no route to delete them.`,
  );

  const profile = createProfileCommands<MemoryCredentials>(memory, {
    service: 'memory',
    displayName: 'Graphiti memory',
    getExtraInfo: (credentials) => (credentials?.baseUrl
      ? ` - ${credentials.baseUrl}${credentials.defaultGroup ? ` (group ${credentials.defaultGroup})` : ''}`
      : ''),
  });

  addExamples(
    profile
      .command('add')
      .description('Connect to a Graphiti server with its URL and the bearer token of the proxy in front of it')
      .argument('[name]', 'Profile name (same as --profile; defaults to the server\'s host name)')
      .option('--url <url>', 'Graphiti server URL (asked for when absent)')
      .option('--token-stdin', `Read the bearer token from stdin (else from ${MEMORY_TOKEN_ENV}, else asked for, hidden)`)
      .option('--group <id>', 'Default group (namespace) for commands without --group')
      .option('--profile <name>', 'Profile name (defaults to the server\'s host name)')
      .option('--read-only', 'Create as read-only profile (search and list only)')
      .action(async (name: string | undefined, options: MemoryProfileAddOptions & { tokenStdin?: boolean }) => {
        try {
          if (name !== undefined && options.profile !== undefined && name !== options.profile) {
            throw new CliError('INVALID_PARAMS', `Two profile names given: "${name}" and --profile "${options.profile}"`);
          }
          const { tokenStdin, ...rest } = options;
          const setupOptions: MemoryProfileAddOptions = { ...rest, profile: options.profile ?? name };
          if (tokenStdin) {
            const piped = await readStdin();
            if (!piped) throw new CliError('INVALID_PARAMS', '--token-stdin reads the token from stdin, but nothing was piped in');
            setupOptions.token = piped;
          } else if (process.env[MEMORY_TOKEN_ENV]) {
            setupOptions.token = process.env[MEMORY_TOKEN_ENV];
          }
          await addProfileWithSetup('memory', (o, context) => memoryProfileAdd(o as MemoryProfileAddOptions, context), setupOptions);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # asks for the token, hidden, so it stays out of shell history
  agentio memory profile add home --url https://graphiti.example.com --group famille

  # in a script: the token from a secret store, on stdin
  agentio secrets get GRAPHITI_TOKEN | agentio memory profile add work --url https://graphiti.example.org --token-stdin

  # or from the environment
  AGENTIO_MEMORY_TOKEN=... agentio memory profile add --url https://graphiti.example.com --read-only

Each profile is one Graphiti server; pick it with --profile on every
command. The token goes into the vault and is sent as
"Authorization: Bearer <token>". There is no --token flag, so it never
lands in shell history or process listings.`,
  );
}
