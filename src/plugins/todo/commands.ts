import { Command } from 'commander';
import { launchBrowser } from '../../auth/oauth-server';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption, printJson } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { prompt } from '../../utils/stdin';
import { addProfileWithSetup } from '../profile-host';
import type { SetupResult } from '../../plugin-sdk';
import type { ProfileAddOptions } from '../types';
import { TodoClient, normaliseBaseUrl } from './client';
import { deviceLabel, todoDeviceLogin } from './device-auth';
import { printDeleted, printTags, printTodo, printTodoList } from './output';
import type { TodoCredentials } from './types';

const getTodoClient = createClientGetter<TodoCredentials, TodoClient>({
  service: 'todo',
  createClient: (credentials) => new TodoClient(credentials),
});

async function getWritableClient(profileName: string | undefined, operation: string): Promise<TodoClient> {
  const { client, profile } = await getTodoClient(profileName);
  await enforceWriteAccess('todo', profile, operation);
  return client;
}

function leaf(parent: Command, name: string, description: string): Command {
  return addJsonOption(
    parent
      .command(name)
      .description(description)
      .option('--profile <name>', 'Profile name (optional if only one profile exists)'),
  );
}

function run<A extends unknown[]>(action: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      handleError(error);
    }
  };
}

export interface TodoProfileAddOptions extends ProfileAddOptions {
  url?: string;
  browser?: boolean;
  json?: boolean;
}

export interface TodoSetupDeps {
  prompt?: typeof prompt;
  openBrowser?: (url: string) => void;
  deviceLogin?: typeof todoDeviceLogin;
  deviceLabel?: typeof deviceLabel;
}

async function signIn(
  baseUrl: string,
  options: { browser?: boolean; json?: boolean },
  deps: TodoSetupDeps = {},
): Promise<TodoCredentials> {
  const openBrowser = deps.openBrowser ?? ((url: string) => { void launchBrowser(url); });
  const deviceLogin = deps.deviceLogin ?? todoDeviceLogin;
  const labelFn = deps.deviceLabel ?? deviceLabel;

  const { token, expiresAt } = await deviceLogin({
    baseUrl,
    label: labelFn(),
    onCode: ({ userCode, verificationUrl }) => {
      if (options.json) {
        printJson({ userCode, verificationUrl });
      } else {
        console.error(`\nTo sign in to Todo, open:\n  ${verificationUrl}\nand check that it shows the code ${userCode}.\n`);
      }
      if (options.browser !== false) openBrowser(verificationUrl);
      console.error('Waiting for approval…');
    },
  });
  const me = await new TodoClient({ baseUrl, token }).me();
  return { baseUrl, token, email: me.email, expiresAt };
}

export async function todoProfileAdd(
  options: TodoProfileAddOptions,
  deps: TodoSetupDeps = {},
): Promise<SetupResult<TodoCredentials>> {
  const input = options.url ?? (await (deps.prompt ?? prompt)('? Todo URL (for example https://todo.example.com): '));
  const baseUrl = normaliseBaseUrl(input);
  const credentials = await signIn(baseUrl, options, deps);
  return {
    credentials,
    suggestedProfileName: credentials.email,
    info: `Signed in to ${new URL(baseUrl).host} as ${credentials.email}`,
  };
}

export async function reauthenticateTodo(
  credentials: TodoCredentials | null,
  profileName: string,
  deps: TodoSetupDeps = {},
): Promise<TodoCredentials> {
  if (!credentials?.baseUrl) {
    throw new CliError('CONFIG_ERROR', `Todo profile "${profileName}" has no URL`,
      `Run: agentio todo profile add --profile ${profileName} --url <url>`);
  }
  console.error(`\nRe-authenticating todo / ${profileName}...`);
  const replacement = await signIn(credentials.baseUrl, {}, deps);
  console.error(`  Done (${replacement.email})`);
  return replacement;
}

export function registerTodoCommands(program: Command): void {
  const todo = program.command('todo').description('Personal tags-only todo list');

  addExamples(
    leaf(todo, 'add', 'Add a todo')
      .argument('<title>', 'Todo title')
      .option('--tag <name>', 'Tag (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
      .option('--notes <text>', 'Optional notes')
      .action(run(async (title: string, options) => {
        const client = await getWritableClient(options.profile, 'add a todo');
        const tags: string[] = options.tag ?? [];
        printTodo(await client.create({ title, tags: tags.length ? tags : undefined, notes: options.notes }), options.json);
      })),
    `Examples:

  agentio todo add "Buy milk" --tag errands --json
  agentio todo add "Ship TRD" --tag agentio --tag work`,
  );

  addExamples(
    leaf(todo, 'list', 'List todos')
      .option('--tag <name>', 'Filter by tag')
      .option('--open', 'Only open todos (default)')
      .option('--done', 'Only done todos')
      .option('--all', 'Open and done')
      .action(run(async (options) => {
        const { client } = await getTodoClient(options.profile);
        const status = options.all ? 'all' : options.done ? 'done' : 'open';
        printTodoList(await client.list({ tag: options.tag, status }), options.json);
      })),
    `Examples:

  agentio todo list --tag errands --open --json
  agentio todo list --done`,
  );

  addExamples(
    leaf(todo, 'get', 'Get one todo by id')
      .argument('<id>', 'Todo id (tod_…)')
      .action(run(async (id: string, options) => {
        const { client } = await getTodoClient(options.profile);
        printTodo(await client.get(id), options.json);
      })),
    `Examples:

  agentio todo get tod_abc123 --json`,
  );

  addExamples(
    leaf(todo, 'check', 'Mark a todo done')
      .argument('<id>', 'Todo id (tod_…)')
      .action(run(async (id: string, options) => {
        const client = await getWritableClient(options.profile, 'check a todo');
        printTodo(await client.check(id), options.json);
      })),
    `Examples:

  agentio todo check tod_abc123`,
  );

  addExamples(
    leaf(todo, 'uncheck', 'Reopen a done todo')
      .argument('<id>', 'Todo id (tod_…)')
      .action(run(async (id: string, options) => {
        const client = await getWritableClient(options.profile, 'uncheck a todo');
        printTodo(await client.uncheck(id), options.json);
      })),
    `Examples:

  agentio todo uncheck tod_abc123`,
  );

  addExamples(
    leaf(todo, 'rm', 'Delete a todo')
      .argument('<id>', 'Todo id (tod_…)')
      .option('--confirm', 'Required: deleting cannot be undone')
      .action(run(async (id: string, options) => {
        if (!options.confirm) {
          throw new CliError('INVALID_PARAMS', 'Deleting a todo cannot be undone', 'Pass --confirm to delete it');
        }
        const client = await getWritableClient(options.profile, 'delete a todo');
        await client.remove(id);
        printDeleted(id.trim(), options.json);
      })),
    `Examples:

  agentio todo rm tod_abc123 --confirm`,
  );

  const tag = todo.command('tag').description('Tag helpers');
  addExamples(
    leaf(tag, 'list', 'List tags with counts')
      .action(run(async (options) => {
        const { client } = await getTodoClient(options.profile);
        printTags(await client.listTags(), options.json);
      })),
    `Examples:

  agentio todo tag list --json`,
  );

  const profile = createProfileCommands<TodoCredentials>(todo, {
    service: 'todo',
    displayName: 'Todo',
    getExtraInfo: (credentials) => (credentials?.baseUrl ? ` - ${credentials.baseUrl}` : ''),
  });

  addExamples(
    addJsonOption(
      profile
        .command('add')
        .description('Sign in to a Todo server in the browser and store the profile')
        .option('--url <url>', 'Todo server URL (asked for when absent)')
        .option('--profile <name>', 'Profile name (defaults to the account email)')
        .option('--read-only', 'Create as read-only profile (blocks write operations)')
        .option('--no-browser', 'Print the sign-in link without opening a browser'),
    ).action(run(async (options: TodoProfileAddOptions) => {
      await addProfileWithSetup('todo', (o) => todoProfileAdd(o as TodoProfileAddOptions), options);
    })),
    `Examples:

  agentio todo profile add --url https://todo.example.com
  agentio todo profile add --url https://todo.example.com --no-browser`,
  );
}
