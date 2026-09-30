import { Command } from 'commander';
import { stat, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
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
import { KiteClient, normaliseBaseUrl, readDocumentFile, requireDocumentId } from './client';
import { deviceLabel, kiteDeviceLogin } from './device-auth';
import {
  printDeleted,
  printDocument,
  printDocumentList,
  printFetchedDocument,
  printReply,
  printSharing,
  printThread,
  printThreads,
} from './output';
import type { KiteCredentials } from './types';

const getKiteClient = createClientGetter<KiteCredentials, KiteClient>({
  service: 'kite',
  createClient: (credentials) => new KiteClient(credentials),
});

/** The client for a command that changes something; a read-only profile is refused before any request. */
async function getWritableClient(profileName: string | undefined, operation: string): Promise<KiteClient> {
  const { client, profile } = await getKiteClient(profileName);
  await enforceWriteAccess('kite', profile, operation);
  return client;
}

/** A leaf command with the options every Kite command takes. */
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

/** Refuse an `--out` path that cannot take a file, before anything is fetched. */
async function checkOutPath(path: string): Promise<string> {
  const target = resolve(path);
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) throw new CliError('INVALID_PARAMS', `--out is a directory: ${path}`, 'Name a file');
  if (!info) {
    const parent = await stat(dirname(target)).catch(() => null);
    if (!parent?.isDirectory()) throw new CliError('INVALID_PARAMS', `Cannot write ${path}: its folder does not exist`);
  }
  return target;
}

export interface KiteProfileAddOptions extends ProfileAddOptions {
  url?: string;
  /** `--no-browser` sets this to false. */
  browser?: boolean;
  json?: boolean;
}

/** What setup reaches outside the process through; tests replace all of it. */
export interface KiteSetupDeps {
  openBrowser?: (url: string) => boolean;
  prompt?: (question: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Browser sign-in against `baseUrl`, then who the token belongs to. Nothing is stored here. */
async function signIn(baseUrl: string, options: KiteProfileAddOptions, deps: KiteSetupDeps): Promise<KiteCredentials> {
  const openBrowser = deps.openBrowser ?? launchBrowser;
  const { token, expiresAt } = await kiteDeviceLogin({
    baseUrl,
    label: deviceLabel(),
    sleep: deps.sleep,
    now: deps.now,
    onCode: ({ userCode, verificationUrl, expiresInSeconds }) => {
      if (options.json) {
        printJson({ event: 'code', userCode, verificationUrl, expiresIn: expiresInSeconds });
      } else {
        console.error(`\nTo sign in to Kite, open:\n  ${verificationUrl}\nand check that it shows the code ${userCode}.\n`);
      }
      if (options.browser !== false) openBrowser(verificationUrl);
      console.error('Waiting for approval…');
    },
  });
  const me = await new KiteClient({ baseUrl, token }).me();
  return { baseUrl, token, email: me.email, expiresAt };
}

export async function kiteProfileAdd(
  options: KiteProfileAddOptions,
  deps: KiteSetupDeps = {},
): Promise<SetupResult<KiteCredentials>> {
  const input = options.url ?? (await (deps.prompt ?? prompt)('? Kite URL (for example https://kite.example.com): '));
  const baseUrl = normaliseBaseUrl(input);
  const credentials = await signIn(baseUrl, options, deps);
  return {
    credentials,
    suggestedProfileName: credentials.email,
    info: `Signed in to ${new URL(baseUrl).host} as ${credentials.email}`,
  };
}

/** A new sign-in against the stored URL; the profile keeps its name. */
export async function reauthenticateKite(
  credentials: KiteCredentials | null,
  profileName: string,
  deps: KiteSetupDeps = {},
): Promise<KiteCredentials> {
  if (!credentials?.baseUrl) {
    throw new CliError('CONFIG_ERROR', `Kite profile "${profileName}" has no URL`,
      `Run: agentio kite profile add --profile ${profileName} --url <url>`);
  }
  console.error(`\nRe-authenticating kite / ${profileName}...`);
  const replacement = await signIn(credentials.baseUrl, {}, deps);
  console.error(`  Done (${replacement.email})`);
  return replacement;
}

export function registerKiteCommands(program: Command): void {
  const kite = program.command('kite').description('Publish Markdown and HTML documents as private web pages on Kite, share them, and work with their comments');

  addExamples(
    leaf(kite, 'publish', 'Publish a Markdown or HTML file as a new document, or update one with --id')
      .argument('<file>', 'A .md, .markdown, .html or .htm file')
      .option('--id <id>', 'Update this document (art_…) instead of publishing a new one')
      .option('--title <title>', 'Document title')
      .action(run(async (file: string, options) => {
        const id = options.id !== undefined ? requireDocumentId(options.id) : undefined;
        const document = await readDocumentFile(file);
        const client = await getWritableClient(options.profile, id ? 'update a document' : 'publish a document');
        const input = { ...document, title: options.title };
        printDocument(id ? await client.update(id, input) : await client.publish(input), options.json);
      })),
    `Examples:

  # publish a Markdown file; prints its id and private link
  agentio kite publish notes.md --title "Weekly notes" --json

  # publish a new version of an existing document
  agentio kite publish notes.md --id art_abc123

Updating fails if someone changed the document since you last read it;
read it again with \`agentio kite get\` and re-apply your change.`,
  );

  addExamples(
    leaf(kite, 'get', 'Read a document by id or link')
      .argument('<id-or-link>', 'A document id (art_…) or its link (https://…/a/<slug>)')
      .option('--out <file>', 'Write the content to this file (replacing it if it exists) instead of printing it')
      .action(run(async (reference: string, options) => {
        const out = options.out !== undefined ? await checkOutPath(options.out) : undefined;
        const { client } = await getKiteClient(options.profile);
        const document = await client.get(reference);
        if (!out) {
          printFetchedDocument(document, options.json);
          return;
        }
        const { content, ...rest } = document;
        try {
          await writeFile(out, content);
        } catch {
          throw new CliError('INVALID_PARAMS', `Cannot write ${options.out}`);
        }
        printFetchedDocument({ ...rest, file: out }, options.json);
      })),
    `Examples:

  # read a document someone sent you a link to
  agentio kite get https://kite.example.com/a/Xy7fQ2

  # save your own document to a file, to edit and publish again
  agentio kite get art_abc123 --out notes.md --json`,
  );

  addExamples(
    leaf(kite, 'list', 'List your documents, newest first')
      .action(run(async (options) => {
        const { client } = await getKiteClient(options.profile);
        printDocumentList(await client.list(), options.json);
      })),
    `Examples:

  # every document you own
  agentio kite list --json`,
  );

  addExamples(
    leaf(kite, 'delete', 'Delete a document for good')
      .argument('<id>', 'Document id (art_…)')
      .option('--confirm', 'Required: deleting cannot be undone')
      .action(run(async (id: string, options) => {
        const docId = requireDocumentId(id);
        if (!options.confirm) {
          throw new CliError('INVALID_PARAMS', 'Deleting a document cannot be undone', 'Pass --confirm to delete it');
        }
        const client = await getWritableClient(options.profile, 'delete a document');
        await client.delete(docId);
        printDeleted(docId, options.json);
      })),
    `Examples:

  # delete a document and its link
  agentio kite delete art_abc123 --confirm`,
  );

  registerShareCommands(kite);
  registerCommentCommands(kite);

  const profile = createProfileCommands<KiteCredentials>(kite, {
    service: 'kite',
    displayName: 'Kite',
    getExtraInfo: (credentials) => (credentials?.baseUrl ? ` - ${credentials.baseUrl}` : ''),
  });

  addExamples(
    addJsonOption(
      profile
        .command('add')
        .description('Sign in to a Kite server in the browser and store the profile')
        .option('--url <url>', 'Kite server URL (asked for when absent)')
        .option('--profile <name>', 'Profile name (defaults to the account email)')
        .option('--read-only', 'Create as read-only profile (blocks write operations)')
        .option('--no-browser', 'Print the sign-in link without opening a browser'),
    ).action(async (options: KiteProfileAddOptions) => {
      try {
        await addProfileWithSetup('kite', (o) => kiteProfileAdd(o as KiteProfileAddOptions), options);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # sign in to a Kite server; the browser opens on the approval page
  agentio kite profile add --url https://kite.example.com

  # over SSH: print the link and code instead of opening a browser
  agentio kite profile add --url https://kite.example.com --no-browser

  # a second, read-only account under a chosen name
  agentio kite profile add --url https://kite.example.com --profile team --read-only`,
  );
}

function registerShareCommands(kite: Command): void {
  const share = kite.command('share').description('See and change who can open a document');

  addExamples(
    leaf(share, 'show', 'Show who can open a document')
      .argument('<id>', 'Document id (art_…)')
      .action(run(async (id: string, options) => {
        const docId = requireDocumentId(id);
        const { client } = await getKiteClient(options.profile);
        printSharing(await client.sharing(docId), options.json);
      })),
    `Examples:

  agentio kite share show art_abc123 --json`,
  );

  addExamples(
    leaf(share, 'add', 'Share a document with a person (emailed) or everyone at a domain')
      .argument('<id>', 'Document id (art_…)')
      .argument('<email-or-domain>', 'An email address, or a domain such as example.com')
      .action(run(async (id: string, target: string, options) => {
        const docId = requireDocumentId(id);
        const client = await getWritableClient(options.profile, 'share a document');
        printSharing(await client.share(docId, target), options.json);
      })),
    `Examples:

  # share with one person; they get an email the first time
  agentio kite share add art_abc123 alice@example.com

  # share with everyone signed in with an example.com address
  agentio kite share add art_abc123 example.com`,
  );

  addExamples(
    leaf(share, 'remove', 'Stop sharing a document with a person or a domain')
      .argument('<id>', 'Document id (art_…)')
      .argument('<email-or-domain>', 'The email address or domain to remove')
      .action(run(async (id: string, target: string, options) => {
        const docId = requireDocumentId(id);
        const client = await getWritableClient(options.profile, 'unshare a document');
        printSharing(await client.unshare(docId, target), options.json);
      })),
    `Examples:

  agentio kite share remove art_abc123 alice@example.com`,
  );

  for (const [name, isPublic, description] of [
    ['public', true, 'Let anyone with the link open the document'],
    ['private', false, 'Only the people and domains it is shared with can open the document'],
  ] as const) {
    addExamples(
      leaf(share, name, description)
        .argument('<id>', 'Document id (art_…)')
        .action(run(async (id: string, options) => {
          const docId = requireDocumentId(id);
          const client = await getWritableClient(options.profile, `make a document ${name}`);
          printSharing(await client.setPublic(docId, isPublic), options.json);
        })),
      `Examples:

  agentio kite share ${name} art_abc123`,
    );
  }

  addExamples(
    leaf(share, 'expiry', 'Set when sharing ends')
      .argument('<id>', 'Document id (art_…)')
      .argument('<duration>', 'Hours or days from now (12h, 30d, 2 days), or forever')
      .action(run(async (id: string, duration: string, options) => {
        const docId = requireDocumentId(id);
        const client = await getWritableClient(options.profile, 'change when sharing ends');
        printSharing(await client.setExpiry(docId, duration), options.json);
      })),
    `Examples:

  # sharing ends in 30 days
  agentio kite share expiry art_abc123 30d

  # sharing never ends
  agentio kite share expiry art_abc123 forever`,
  );
}

function registerCommentCommands(kite: Command): void {
  const comments = kite.command('comments').description('Read and answer comments on a document');

  addExamples(
    leaf(comments, 'list', 'List comment threads on a document')
      .argument('<id>', 'Document id (art_…)')
      .option('--status <status>', 'open or resolved')
      .option('--since <timestamp>', 'Only threads with a comment after this ISO 8601 time')
      .action(run(async (id: string, options) => {
        const docId = requireDocumentId(id);
        const { client } = await getKiteClient(options.profile);
        printThreads(await client.comments(docId, { status: options.status, since: options.since }), options.json);
      })),
    `Examples:

  # open threads on a document
  agentio kite comments list art_abc123 --status open --json

  # what is new since you last looked
  agentio kite comments list art_abc123 --since 2026-01-31T09:00:00Z`,
  );

  addExamples(
    leaf(comments, 'add', 'Comment on a document, a passage or an element')
      .argument('<id>', 'Document id (art_…)')
      .requiredOption('--body <text>', 'The comment; @email mentions notify people')
      .option('--snippet <text>', 'Exact text of the passage, as rendered (8 to 2000 characters)')
      .option('--heading <id>', 'Search for the snippet only under this heading id (needs --snippet)')
      .option('--element-id <id>', 'HTML documents: the id of the element to comment on')
      .action(run(async (id: string, options) => {
        const docId = requireDocumentId(id);
        const client = await getWritableClient(options.profile, 'comment');
        const input = { body: options.body, snippet: options.snippet, heading: options.heading, elementId: options.elementId };
        printThread(await client.comment(docId, input), options.json);
      })),
    `Examples:

  # a comment on the whole document
  agentio kite comments add art_abc123 --body "Looks good overall"

  # a comment on a passage, found anywhere in the document
  agentio kite comments add art_abc123 --snippet "ship it by Friday" --body "Is Friday realistic?"

  # only look for the passage under one heading
  agentio kite comments add art_abc123 --snippet "ship it by Friday" --heading timeline --body "Which Friday?"`,
  );

  addExamples(
    leaf(comments, 'reply', 'Reply to a comment thread')
      .argument('<thread-id>', 'Thread id (thr_…)')
      .requiredOption('--body <text>', 'The reply')
      .action(run(async (threadId: string, options) => {
        const client = await getWritableClient(options.profile, 'reply to a comment');
        printReply(await client.reply(threadId, options.body), options.json);
      })),
    `Examples:

  agentio kite comments reply thr_abc123 --body "Done, see version 3"`,
  );

  for (const [name, status, description] of [
    ['resolve', 'resolved', 'Mark a comment thread resolved'],
    ['reopen', 'open', 'Reopen a resolved comment thread'],
  ] as const) {
    addExamples(
      leaf(comments, name, description)
        .argument('<thread-id>', 'Thread id (thr_…)')
        .action(run(async (threadId: string, options) => {
          const client = await getWritableClient(options.profile, `${name} a comment thread`);
          printThread(await client.setThreadStatus(threadId, status), options.json);
        })),
      `Examples:

  agentio kite comments ${name} thr_abc123`,
    );
  }
}
