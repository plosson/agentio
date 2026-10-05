import { Command } from 'commander';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { prompt } from '../../utils/stdin';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import type { SetupResult } from '../../plugin-sdk';
import type { ProfileAddOptions } from '../types';
import { PagerioClient, parsePagerUrl } from './client';
import { printSentPage } from './output';
import type { PagerioCredentials, PagerioPageInput } from './types';

const getPagerioClient = createClientGetter<PagerioCredentials, PagerioClient>({
  service: 'pagerio',
  createClient: (credentials) => new PagerioClient(credentials),
});

/** A non-empty option value, or undefined when the option was not given. */
function optionalText(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new CliError('INVALID_PARAMS', `${option} cannot be empty`);
  return value.trim();
}

export interface PagerioSendOptions {
  title?: string;
  details?: string;
  link?: string;
  group?: string;
  idempotencyKey?: string;
}

/** The page to post: only the fields given, each trimmed and never blank. */
export function pageInput(message: string | undefined, options: PagerioSendOptions): PagerioPageInput {
  const input: PagerioPageInput = {
    message: optionalText(message, 'The message'),
    title: optionalText(options.title, '--title'),
    details: optionalText(options.details, '--details'),
    url: optionalText(options.link, '--link'),
    group: optionalText(options.group, '--group'),
  };
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as PagerioPageInput;
}

export interface PagerioProfileAddOptions extends ProfileAddOptions {
  url?: string;
}

/** What setup reaches outside the process through; tests replace it. */
export interface PagerioSetupDeps {
  prompt?: (question: string) => Promise<string>;
}

export async function pagerioProfileAdd(
  options: PagerioProfileAddOptions,
  deps: PagerioSetupDeps = {},
): Promise<SetupResult<PagerioCredentials>> {
  const ask = deps.prompt ?? prompt;
  const url = parsePagerUrl(options.url ?? (await ask('? Pager URL (the Copy button on https://pagerio.chuut.com): ')));
  await new PagerioClient({ url }).check();
  return { credentials: { url }, suggestedProfileName: 'default', info: `Connected to Pocket Pager at ${new URL(url).host}` };
}

export function registerPagerioCommands(program: Command): void {
  const pagerio = program.command('pagerio').description('Page yourself on your iPhone and Mac with Pocket Pager');

  addExamples(
    addJsonOption(
      pagerio
        .command('send')
        .description('Send a page: a notification on the pager owner\'s iPhone and Mac')
        .argument('[message]', 'Notification text (default: "You\'ve been paged.")')
        .option('-t, --title <title>', 'Notification title')
        .option('--details <markdown>', 'Longer text in Markdown, shown only when the page is opened')
        .option('-l, --link <url>', 'An http(s) link the notification opens')
        .option('-g, --group <name>', 'Groups related notifications on the device, such as ci or backups')
        .option('--idempotency-key <key>', 'Send the same key again within 24 hours and no second page is sent')
        .option('--profile <name>', 'Profile name (optional if only one profile exists)'),
    ).action(async (message: string | undefined, options: PagerioSendOptions & { profile?: string; json?: boolean }) => {
      try {
        const input = pageInput(message, options);
        const idempotencyKey = optionalText(options.idempotencyKey, '--idempotency-key');
        const { client, profile } = await getPagerioClient(options.profile);
        await enforceWriteAccess('pagerio', profile, 'send a page');
        printSentPage(await client.send(input, idempotencyKey), options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio pagerio send "Build finished"

  agentio pagerio send "Should I run the migration on production?" --title "Agent needs your input" --group agent

  # failure, with a link and details in Markdown
  agentio pagerio send "Disk full on db-1." -t "Nightly backup failed" \\
    -l https://example.com/backups/db-1 --details "**Error:** No space left on device"`,
  );

  const profile = createProfileCommands<PagerioCredentials>(pagerio, {
    service: 'pagerio',
    displayName: 'Pocket Pager',
  });

  addExamples(
    addSetupOptions(
      profile
        .command('add')
        .description('Add a pager with its URL')
        .option('--url <url>', 'Pager URL, from the dashboard\'s Copy button (asked for when absent)')
        .option('--profile <name>', 'Profile name (default: default)')
        .option('--read-only', 'Create as read-only profile (blocks write operations)')
    )
      .action(async (options: PagerioProfileAddOptions) => {
        try {
          await addProfileWithSetup('pagerio', (o) => pagerioProfileAdd(o as PagerioProfileAddOptions), options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # asks for the URL, so it stays out of shell history
  agentio pagerio profile add`,
  );
}
