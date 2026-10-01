import { Command } from 'commander';
import { readFile, stat } from 'fs/promises';
import { extname } from 'path';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { prompt, readStdin } from '../../utils/stdin';
import { addProfileWithSetup } from '../profile-host';
import type { SetupResult } from '../../plugin-sdk';
import type { ProfileAddOptions } from '../types';
import { bodyToHtml, NotesClient, normaliseNotesUrl, parseLimit } from './client';
import { printDeleted, printFolders, printNote, printNoteList, printSavedNote } from './output';
import type { NoteBodyFormat, NoteOutputFormat, NotesCredentials } from './types';

const getNotesClient = createClientGetter<NotesCredentials, NotesClient>({
  service: 'notes',
  createClient: (credentials) => new NotesClient(credentials),
});

/** The client for a command that changes something; a read-only profile is refused before any request. */
async function getWritableClient(profileName: string | undefined, operation: string): Promise<NotesClient> {
  const { client, profile } = await getNotesClient(profileName);
  await enforceWriteAccess('notes', profile, operation);
  return client;
}

/** A leaf command with the options every Notes command takes. */
function leaf(parent: Command, name: string, description: string): Command {
  return addJsonOption(
    parent
      .command(name)
      .description(description)
      .option('--profile <name>', 'Profile name (optional if only one profile exists)'),
  );
}

/** Run a command's action, turning any failure into the standard error output. */
function run<A extends unknown[]>(action: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      handleError(error);
    }
  };
}

function parseBodyFormat(input: string): NoteBodyFormat {
  if (input === 'markdown' || input === 'html' || input === 'text') return input;
  throw new CliError('INVALID_PARAMS', `--format must be markdown, html or text, not "${input}"`);
}

function parseOutputFormat(input: string): NoteOutputFormat {
  if (input === 'markdown' || input === 'html' || input === 'text') return input;
  throw new CliError('INVALID_PARAMS', `--format must be markdown, text or html, not "${input}"`);
}

/** The format of a body file from its extension: .html and .htm are HTML, .txt is text, anything else Markdown. */
function formatFromPath(path: string): NoteBodyFormat {
  const ext = extname(path).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.txt') return 'text';
  return 'markdown';
}

interface BodyOptions {
  body?: string;
  file?: string;
  format?: string;
}

/**
 * The body a command was given, as HTML, or undefined when it was given none.
 * `--file -` reads stdin; stdin is never read unless asked for, so an agent's
 * open pipe cannot hang a command.
 */
export async function readBody(options: BodyOptions): Promise<string | undefined> {
  if (options.body !== undefined && options.file !== undefined) {
    throw new CliError('INVALID_PARAMS', 'Pass either --body or --file, not both');
  }
  let text: string;
  let inferred: NoteBodyFormat = 'markdown';
  if (options.body !== undefined) {
    text = options.body;
  } else if (options.file === '-') {
    const input = await readStdin();
    if (input === null) throw new CliError('INVALID_PARAMS', '--file - reads the body from stdin, but nothing was piped in');
    text = input;
  } else if (options.file !== undefined) {
    const info = await stat(options.file).catch(() => null);
    if (!info) throw new CliError('INVALID_PARAMS', `File not found: ${options.file}`);
    if (info.isDirectory()) throw new CliError('INVALID_PARAMS', `${options.file} is a directory, not a file`);
    try {
      text = await readFile(options.file, 'utf8');
    } catch {
      throw new CliError('INVALID_PARAMS', `Cannot read ${options.file}`);
    }
    inferred = formatFromPath(options.file);
  } else {
    if (options.format !== undefined) throw new CliError('INVALID_PARAMS', '--format needs a body', 'Pass --body or --file');
    return undefined;
  }
  return bodyToHtml(text, options.format !== undefined ? parseBodyFormat(options.format) : inferred);
}

/** A non-empty option value, or undefined when the option was not given. */
function optionalText(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new CliError('INVALID_PARAMS', `${option} cannot be empty`);
  return value;
}

export interface NotesProfileAddOptions extends ProfileAddOptions {
  url?: string;
  apiKey?: string;
}

/** What setup reaches outside the process through; tests replace it. */
export interface NotesSetupDeps {
  prompt?: (question: string) => Promise<string>;
}

/** The profile name a server suggests: the host's first label, or the whole host for an IP address. */
export function suggestedName(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return host;
  return host.split('.')[0];
}

export async function notesProfileAdd(
  options: NotesProfileAddOptions,
  deps: NotesSetupDeps = {},
): Promise<SetupResult<NotesCredentials>> {
  const ask = deps.prompt ?? prompt;
  const baseUrl = normaliseNotesUrl(options.url ?? (await ask('? Notes server URL (for example https://mac-mini.example.ts.net): ')));
  const apiKey = (options.apiKey ?? (await ask('? API key (NOTES_API_KEY on the Mac): '))).trim();
  if (!apiKey) throw new CliError('INVALID_PARAMS', 'The API key is required', 'Pass --api-key, or type it when asked');

  const client = new NotesClient({ baseUrl, apiKey });
  const health = await client.health();
  if (health.platform !== 'darwin') {
    throw new CliError('CONFIG_ERROR', `The Notes server at ${baseUrl} runs on ${health.platform}, not macOS, so it cannot reach Notes.app`);
  }

  let info = `Connected to ${new URL(baseUrl).host} (apple-notes-api ${health.version})`;
  try {
    const folders = await client.folders();
    info += `, ${folders.length} folder${folders.length === 1 ? '' : 's'}`;
  } catch (error) {
    // The key is checked before Notes.app is asked; only a refused key stops setup.
    if (error instanceof CliError && error.code === 'AUTH_FAILED') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Warning: the API key works, but Notes.app did not answer: ${reason}`);
    console.error('Check the Mac (Automation permission for Notes, or a busy Notes.app), then run: agentio notes folders');
  }
  return { credentials: { baseUrl, apiKey }, suggestedProfileName: suggestedName(baseUrl), info };
}

export function registerNotesCommands(program: Command): void {
  const notes = program.command('notes').description('Read, search and write Apple Notes through an apple-notes-api server on a Mac');

  addExamples(
    leaf(notes, 'folders', 'List folders, with the account each belongs to')
      .action(run(async (options) => {
        const { client } = await getNotesClient(options.profile);
        printFolders(await client.folders(), options.json);
      })),
    `Examples:

  agentio notes folders --json`,
  );

  addExamples(
    leaf(notes, 'list', 'List notes (title, folder, dates), without their bodies')
      .option('--folder <name>', 'Only notes in this folder (the first folder with this name)')
      .option('--limit <n>', 'Most notes to return, 1 to 1000 (server default: 100)')
      .action(run(async (options) => {
        const limit = options.limit !== undefined ? parseLimit(options.limit) : undefined;
        const folder = optionalText(options.folder, '--folder');
        const { client } = await getNotesClient(options.profile);
        printNoteList(await client.list({ folder, limit }), options.json);
      })),
    `Examples:

  # the first 20 notes
  agentio notes list --limit 20

  # notes in one folder
  agentio notes list --folder Work --json`,
  );

  addExamples(
    leaf(notes, 'search', 'Find notes whose title or text contains a phrase (case does not matter)')
      .argument('<query>', 'Text to look for')
      .option('--folder <name>', 'Only search this folder (the first folder with this name)')
      .option('--limit <n>', 'Most notes to return, 1 to 1000 (server default: 100)')
      .action(run(async (query: string, options) => {
        if (!query.trim()) throw new CliError('INVALID_PARAMS', 'The search text is empty');
        const limit = options.limit !== undefined ? parseLimit(options.limit) : undefined;
        const folder = optionalText(options.folder, '--folder');
        const { client } = await getNotesClient(options.profile);
        printNoteList(await client.list({ query, folder, limit }), options.json);
      })),
    `Examples:

  agentio notes search grocery

  agentio notes search "quarterly plan" --folder Work --limit 5 --json`,
  );

  addExamples(
    leaf(notes, 'get', 'Read a note')
      .argument('<id>', 'Note id (x-coredata://…), from list or search')
      .option('--format <format>', 'Body format: markdown, text or html', 'markdown')
      .action(run(async (id: string, options) => {
        const format = parseOutputFormat(options.format);
        const { client } = await getNotesClient(options.profile);
        printNote(await client.get(id), format, options.json);
      })),
    `Examples:

  agentio notes get "x-coredata://…/ICNote/p123"

  # the HTML Notes stores; --json returns all three formats
  agentio notes get "x-coredata://…/ICNote/p123" --format html`,
  );

  addExamples(
    leaf(notes, 'create', 'Create a note')
      .requiredOption('--title <title>', 'Note title')
      .option('--body <text>', 'Note body')
      .option('--file <path>', 'Read the body from a file, or from stdin with -')
      .option('--format <format>', 'Body format: markdown, html or text (default: markdown, or from the file extension)')
      .option('--folder <name>', 'Folder to create it in (default: Notes); it must exist')
      .action(run(async (options) => {
        const name = optionalText(options.title, '--title')!;
        const folder = optionalText(options.folder, '--folder');
        const body = (await readBody(options)) ?? '';
        const client = await getWritableClient(options.profile, 'create a note');
        printSavedNote(await client.create({ name, body, folder }), 'Created', options.json);
      })),
    `Examples:

  # a Markdown body, rendered as Notes formatting
  agentio notes create --title "Groceries" --body "- milk
- eggs"

  # the body from a file, into a folder
  agentio notes create --title "Meeting" --file meeting.md --folder Work --json

  # the body from another command
  some-command | agentio notes create --title "Output" --file - --format text`,
  );

  addExamples(
    leaf(notes, 'update', 'Change a note\'s title, replace its body, or move it to another folder')
      .argument('<id>', 'Note id (x-coredata://…)')
      .option('--title <title>', 'New title')
      .option('--body <text>', 'New body; replaces the whole body, and erases checklists')
      .option('--file <path>', 'Read the new body from a file, or from stdin with -')
      .option('--format <format>', 'Body format: markdown, html or text (default: markdown, or from the file extension)')
      .option('--folder <name>', 'Move the note to this folder; it must exist')
      .action(run(async (id: string, options) => {
        const name = optionalText(options.title, '--title');
        const folder = optionalText(options.folder, '--folder');
        const body = await readBody(options);
        const client = await getWritableClient(options.profile, 'update a note');
        printSavedNote(await client.update(id, { name, body, folder }), 'Updated', options.json);
      })),
    `Examples:

  # move a note
  agentio notes update "x-coredata://…/ICNote/p123" --folder Archive

  # replace the body; read the note first, since the old body is lost
  agentio notes update "x-coredata://…/ICNote/p123" --file note.md

Warning: a new body (--body or --file) turns Notes checklists into plain
lists and loses which items are ticked. Moving a note with --folder alone
leaves its body untouched.`,
  );

  addExamples(
    leaf(notes, 'delete', 'Move a note to Recently Deleted')
      .argument('<id>', 'Note id (x-coredata://…)')
      .action(run(async (id: string, options) => {
        const client = await getWritableClient(options.profile, 'delete a note');
        printDeleted((await client.delete(id)).id, options.json);
      })),
    `Examples:

  agentio notes delete "x-coredata://…/ICNote/p123"

The note stays in Recently Deleted in Notes.app for 30 days.`,
  );

  const profile = createProfileCommands<NotesCredentials>(notes, {
    service: 'notes',
    displayName: 'Apple Notes',
    getExtraInfo: (credentials) => (credentials?.baseUrl ? ` - ${credentials.baseUrl}` : ''),
  });

  addExamples(
    profile
      .command('add')
      .description('Connect to an apple-notes-api server with its URL and API key')
      .option('--url <url>', 'Server URL (asked for when absent)')
      .option('--api-key <key>', 'The server\'s NOTES_API_KEY (asked for when absent)')
      .option('--profile <name>', 'Profile name (defaults to the server\'s host name)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(run(async (options: NotesProfileAddOptions) => {
        await addProfileWithSetup('notes', (o) => notesProfileAdd(o as NotesProfileAddOptions), options);
      })),
    `Examples:

  # asks for the API key, so it stays out of shell history
  agentio notes profile add --url https://mac-mini.example.ts.net

  # a read-only profile under a chosen name
  agentio notes profile add --url https://mac-mini.example.ts.net --profile home --read-only`,
  );
}
