import type { Command } from 'commander';
import { readFile } from 'fs/promises';
import { addProfileWithSetup } from '../profile-host';
import { addExamples } from '../../utils/command-tree';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { createProfileCommands } from '../../utils/profile-commands';
import { addJsonOption } from '../../utils/output';
import { enforceWriteAccess } from '../../utils/read-only';
import { confirm, readStdin, readStdinRaw } from '../../utils/stdin';
import { exportSlackAttachments, downloadTarget, saveFile } from './attachments';
import { checkUserToken, fileIdFrom, SlackClient } from './client';
import { checkRange, checkTypes, collectMessages, SLACK_CONVERSATION_TYPES } from './messages';
import { CANVAS_ARGUMENT, checkAccessLevel, describeTargets, findCanvases, readCanvas, resolveCanvasId, resolveTargets } from './canvases';
import { checkWebhookUrl } from '../webhook-check';
import { answerOrAsk } from '../setup-inputs';
import {
  printSlackArchive,
  printSlackCanvasChange,
  printSlackCanvasContent,
  printSlackCanvasList,
  printSlackAttachments,
  printSlackDownload,
  printSlackLeave,
  printSlackChannel,
  printSlackChannelList,
  printSlackChannelMembers,
  printSlackMembership,
  printSlackMessages,
  printSlackSendResult,
  printSlackUser,
  printSlackUserList,
} from './output';
import type { SlackCredentials, SlackTokenCredentials, SlackWebhookCredentials } from './types';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import type { ProfileAddOptions } from '../types';

const SLACK_WEBHOOK_INPUT: InputSpec = {
  label: 'Webhook URL', kind: 'secret',
  help: 'From your Slack app: Incoming Webhooks, Add New Webhook to Workspace (https://api.slack.com/apps)',
};
const SLACK_CHANNEL_INPUT: InputSpec = { label: 'Channel name', kind: 'text', required: false, help: 'Only for display; also the default profile name' };
const SLACK_KIND_INPUT: InputSpec = {
  label: 'Profile type', kind: 'choice', default: 'webhook',
  choices: [
    { value: 'webhook', label: 'Incoming webhook (send messages to one channel)' },
    { value: 'token', label: 'User token (manage and read as you)' },
  ],
};
const SLACK_TOKEN_INPUT: InputSpec = {
  label: 'User OAuth Token', kind: 'secret',
  help: 'From your Slack app: OAuth & Permissions, User OAuth Token (starts with xoxp-)',
};

/** The User Token Scopes the token commands need. */
export const SLACK_USER_SCOPES = [
  'users:read', 'users:read.email',
  'channels:read', 'groups:read', 'im:read', 'mpim:read',
  'channels:manage', 'groups:write',
  'channels:write.invites', 'groups:write.invites',
  'channels:write',
  'channels:history', 'groups:history', 'im:history', 'mpim:history',
  'canvases:read', 'canvases:write', 'files:read',
  'search:read',
];

export interface SlackProfileAddOptions extends ProfileAddOptions {
  /** Skips the profile type question. */
  kind?: 'webhook' | 'token';
  /** A user token given by the caller instead of asked for; implies kind token. */
  token?: string;
}

const getSlackClient = createClientGetter<SlackCredentials, SlackClient>({
  service: 'slack',
  createClient: (credentials) => new SlackClient(credentials),
});

/** A leaf command with the options every token command takes. */
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

/** A repeatable option's values, in order. */
const repeatable = (value: string, previous: string[] = []) => [...previous, value];

/** Markdown from a file, or from stdin when no file is given; '' when there is none. */
async function readMarkdown(file: string | undefined): Promise<string> {
  if (file === undefined) return (await readStdinRaw()) ?? '';
  try {
    return await readFile(file, 'utf-8');
  } catch {
    throw new CliError('INVALID_PARAMS', `Cannot read ${file}`, 'Check that the file exists and is readable');
  }
}

/** After a change, the canvas as it is now. */
async function reportCanvasChange(client: SlackClient, id: string, verb: string, json?: boolean): Promise<void> {
  printSlackCanvasChange(await client.canvasInfo(id), verb, json);
}

/** Progress on one stderr line, only on a terminal. */
function progress(done: number, total: number): void {
  if (!process.stderr.isTTY) return;
  process.stderr.write(`\rReading ${done}/${total} conversations…${done === total ? '\n' : ''}`);
}

/** The options messages and attachments share, checked. */
function messagesOptions(options: { since?: string; until?: string; types?: string; channel?: string[]; includePublic?: boolean; raw?: boolean }) {
  return {
    range: checkRange(options.since, options.until),
    types: checkTypes(options.types),
    channels: options.channel,
    includePublic: !!options.includePublic,
    raw: !!options.raw,
    onWarning: (message: string) => console.error(`Warning: ${message}`),
    onProgress: progress,
  };
}

async function getWritableClient(profileName: string | undefined, operation: string): Promise<SlackClient> {
  const { client, profile } = await getSlackClient(profileName);
  await enforceWriteAccess('slack', profile, operation);
  return client;
}

export function registerSlackCommands(program: Command): void {
  const slack = program
    .command('slack')
    .description('Slack operations');

  addExamples(
    slack
      .command('send')
      .description('Send a message to Slack')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--json [file]', 'Send Block Kit message from JSON file (or stdin if no file specified)')
      .argument('[message]', 'Message text (or pipe via stdin)')
      .action(async (message: string | undefined, options) => {
        try {
          let text: string | undefined = message;
          let payload: Record<string, unknown> | undefined;

          if (options.json !== undefined) {
            if (message) {
              throw new CliError(
                'INVALID_PARAMS',
                'Cannot use both text message and --json option',
                'Use either: agentio slack send "text" OR agentio slack send --json file.json',
              );
            }

            let jsonContent: string;

            if (typeof options.json === 'string') {
              try {
                jsonContent = await readFile(options.json, 'utf-8');
              } catch {
                throw new CliError(
                  'INVALID_PARAMS',
                  `Failed to read JSON file: ${options.json}`,
                  'Check that the file exists and is readable',
                );
              }
            } else {
              const stdinContent = await readStdin();
              if (!stdinContent) {
                throw new CliError(
                  'INVALID_PARAMS',
                  'No JSON provided via stdin',
                  'Pipe JSON content: cat message.json | agentio slack send --json',
                );
              }
              jsonContent = stdinContent;
            }

            try {
              payload = JSON.parse(jsonContent) as Record<string, unknown>;
            } catch (err) {
              throw new CliError(
                'INVALID_PARAMS',
                `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
                'Check that the JSON is valid',
              );
            }
          } else {
            if (!text) {
              text = await readStdin() || undefined;
            }

            if (!text) {
              throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
            }
          }

          const { client, profile } = await getSlackClient(options.profile);
          await enforceWriteAccess('slack', profile, 'send message');
          const result = await client.send({ text, payload });
          printSlackSendResult(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # send a quick text message to the default profile
  agentio slack send "deploy finished"

  # pipe message body via stdin
  echo "build failed: see logs" | agentio slack send

  # send a Block Kit payload from a JSON file
  agentio slack send --json ./alert.json

  # send to a specific profile
  agentio slack send --profile alerts "incident opened"`,
  );

  addExamples(
    leaf(slack, 'messages', 'Read every message since a date in the conversations you are in (with --include-public, every public channel too), threads included (needs a user token profile)')
      .option('--since <date>', 'Start, included: YYYY-MM-DD (midnight UTC) or an ISO 8601 timestamp')
      .option('--until <date>', 'End, included, same formats; a date alone means the end of that day (default: now)')
      .option('--channel <channel>', 'Only this conversation, by id or name; repeat for more', repeatable)
      .option('--types <list>', `Comma-separated: ${SLACK_CONVERSATION_TYPES.join(', ')} (default: all)`)
      .option('--include-public', 'Also read public channels you are not in, without joining them')
      .option('--raw', 'Keep Slack\'s text markup as sent: <@U…> mentions, <url|label> links')
      .action(run(async (options) => {
        const result = await collectMessages((await getSlackClient(options.profile)).client, messagesOptions(options));
        printSlackMessages(result, options.json);
      })),
    `Examples:

  # everything since Monday, for a digest
  agentio slack messages --since 2026-10-26

  # one week of two channels, as JSON
  agentio slack messages --since 2026-10-01 --until 2026-10-08 --channel eng --channel '#design' --json

  # direct messages only
  agentio slack messages --since 2026-10-20 --types dm,group

  # also the public channels you never joined; nothing is joined or marked read
  agentio slack messages --since 2026-10-26 --include-public

Replies in threads that started before --since are found through search
(needs search:read); without it they are left out, with a warning.

In --json, each conversation has isMember; each message has permalink, and
realName and displayName for its author; each file has id, name, mimetype,
size, urlPrivateDownload and permalink (download it with: agentio slack download).
Links read "label (url)" and mentions "@name"; --raw keeps Slack's markup.`,
  );

  addExamples(
    leaf(slack, 'download', 'Download one file shared in Slack (needs files:read)')
      .argument('<file>', 'File id (F…), or the file\'s permalink or private download URL')
      .option('--out <path>', 'File to write, or a folder to write into (default: the file\'s name in the current folder)')
      .action(run(async (file: string, options) => {
        const { client } = await getSlackClient(options.profile);
        const info = await client.fileInfo(fileIdFrom(file));
        const path = await downloadTarget(options.out, info.name);
        const saved = await saveFile(client, info, path);
        printSlackDownload(path, saved.bytes, saved.file, options.json);
      })),
    `Examples:

  # file ids are in: agentio slack messages --json (files[].id)
  agentio slack download F0123ABCDEF --out ./screenshot.png

  # by link, into a folder
  agentio slack download https://files.slack.com/files-pri/T0123ABCD-F0123ABCDEF/download/report.pdf --out ./files/`,
  );

  addExamples(
    leaf(slack, 'attachments', 'Download every file shared in a date range, with a manifest (needs files:read)')
      .option('--since <date>', 'Start, included: YYYY-MM-DD (midnight UTC) or an ISO 8601 timestamp')
      .option('--until <date>', 'End, included, same formats; a date alone means the end of that day (default: now)')
      .option('--channel <channel>', 'Only this conversation, by id or name; repeat for more (default: all)', repeatable)
      .option('--types <list>', `Comma-separated: ${SLACK_CONVERSATION_TYPES.join(', ')} (default: all)`)
      .option('--include-public', 'Also public channels you are not in, without joining them')
      .option('--out <dir>', 'Folder to save files and manifest.json / manifest.csv into', 'slack-attachments')
      .option('--dry-run', 'Only list the files and write the manifest; download nothing')
      .action(run(async (options) => {
        const { client } = await getSlackClient(options.profile);
        const messages = await collectMessages(client, messagesOptions(options));
        const result = await exportSlackAttachments(client, messages, {
          outDir: options.out,
          dryRun: !!options.dryRun,
          onProgress: (entry, index) => {
            const tag = entry.error ? `${entry.status}: ${entry.error}` : entry.status;
            console.error(`[${index + 1}] ${entry.name} -> ${entry.savedPath} (${tag})`);
          },
        });
        printSlackAttachments(result, !!options.dryRun, options.json);
        if (result.failed > 0) process.exitCode = 1;
      })),
    `Examples:

  # every file shared in one channel this month
  agentio slack attachments --channel eng --since 2026-10-01 --out ./eng-files

  # see what would be saved, without downloading
  agentio slack attachments --since 2026-10-26 --dry-run

Files are named <YYYY-MM-DD>_<sender>_<file name>; clashes get " (2)", " (3)"...
The manifest has one row per file: conversation, message ts and permalink,
sender, file id, name, type, size, saved path, status and error. Deleted files,
files hidden by the plan's history limit and links to files stored outside
Slack are recorded as skipped. A file that fails is recorded with its error and
the run continues; the exit code is 1 if any failed.`,
  );

  const users = slack.command('users').description('Workspace members (needs a user token profile)');

  addExamples(
    leaf(users, 'list', 'List workspace members, with their display names')
      .option('--include-deleted', 'Also list deactivated accounts')
      .option('--include-bots', 'Also list bots and Slackbot')
      .action(run(async (options) => {
        const { client } = await getSlackClient(options.profile);
        printSlackUserList(await client.listUsers({
          includeDeleted: !!options.includeDeleted,
          includeBots: !!options.includeBots,
        }), options.json);
      })),
    `Examples:

  agentio slack users list

  # members without a display name
  agentio slack users list --json | jq '.users[] | select(.displayName == null) | .email'`,
  );

  addExamples(
    leaf(users, 'get', 'Show one member, by user id or email address')
      .argument('<user>', 'User id (U…) or email address')
      .action(run(async (user: string, options) => {
        const { client } = await getSlackClient(options.profile);
        printSlackUser(await client.getUser(user), options.json);
      })),
    `Examples:

  agentio slack users get jane@example.com
  agentio slack users get U012AB3CD --json`,
  );

  const channels = slack.command('channels').description('Channels: create, change, archive, and invite or uninvite members (needs a user token profile)');

  addExamples(
    leaf(channels, 'list', 'List channels: every public one, and the private ones you belong to')
      .option('--private-only', 'Only private channels')
      .option('--include-archived', 'Also list archived channels')
      .action(run(async (options) => {
        const { client } = await getSlackClient(options.profile);
        printSlackChannelList(await client.listChannels({
          privateOnly: !!options.privateOnly,
          includeArchived: !!options.includeArchived,
        }), options.json);
      })),
    `Examples:

  agentio slack channels list
  agentio slack channels list --private-only --json`,
  );

  addExamples(
    leaf(channels, 'get', 'Show one channel, by id or name')
      .argument('<channel>', 'Channel id (C…) or name, with or without #')
      .action(run(async (channel: string, options) => {
        const { client } = await getSlackClient(options.profile);
        printSlackChannel(await client.getChannel(channel), options.json);
      })),
    `Examples:

  agentio slack channels get general
  agentio slack channels get C012AB3CD --json`,
  );

  addExamples(
    leaf(channels, 'create', 'Create a channel; you become its first member')
      .argument('<name>', 'Lowercase letters, digits, hyphens and underscores, at most 80')
      .option('--private', 'Create a private channel')
      .option('--topic <text>', 'Channel topic, shown in the header')
      .option('--purpose <text>', 'Channel description')
      .action(run(async (name: string, options) => {
        const client = await getWritableClient(options.profile, 'create a channel');
        const channel = await client.createChannel(name, { isPrivate: !!options.private, topic: options.topic, purpose: options.purpose });
        printSlackChannel(channel, options.json, 'Created');
      })),
    `Examples:

  agentio slack channels create team-design --topic "Design reviews" --purpose "Where the design team works"
  agentio slack channels create hr-private --private`,
  );

  addExamples(
    leaf(channels, 'set', 'Change a channel\'s name, topic or purpose')
      .argument('<channel>', 'Channel id (C…) or name, with or without #')
      .option('--name <name>', 'New name')
      .option('--topic <text>', 'New topic; "" clears it')
      .option('--purpose <text>', 'New description; "" clears it')
      .action(run(async (channel: string, options) => {
        const client = await getWritableClient(options.profile, 'change a channel');
        const updated = await client.updateChannel(channel, { name: options.name, topic: options.topic, purpose: options.purpose });
        printSlackChannel(updated, options.json, 'Updated');
      })),
    `Examples:

  agentio slack channels set team-design --topic "Reviews on Thursdays"
  agentio slack channels set C012AB3CD --name design-team --purpose ""

Only name, topic and purpose can be changed through the API on Business+.
Posting permissions and other settings are in the Slack app.`,
  );

  addExamples(
    leaf(channels, 'archive', 'Archive a channel: read-only and out of the sidebar, history kept')
      .argument('<channel>', 'Channel id (C…) or name, with or without #')
      .action(run(async (channel: string, options) => {
        const client = await getWritableClient(options.profile, 'archive a channel');
        printSlackArchive(await client.archiveChannel(channel), 'Archived', options.json);
      })),
    `Examples:

  agentio slack channels archive old-project

Undo with: agentio slack channels unarchive old-project. Deleting a channel
for good is not possible through the API on Business+; an admin does it in the
Slack app (channel name, Settings, Delete this channel).`,
  );

  addExamples(
    leaf(channels, 'unarchive', 'Bring an archived channel back')
      .argument('<channel>', 'Channel id (C…) or name, with or without #')
      .action(run(async (channel: string, options) => {
        const client = await getWritableClient(options.profile, 'unarchive a channel');
        printSlackArchive(await client.unarchiveChannel(channel), 'Unarchived', options.json);
      })),
    `Examples:

  agentio slack channels unarchive old-project`,
  );

  addExamples(
    leaf(channels, 'leave', 'Leave channels yourself')
      .argument('<channels...>', 'Channel ids (C…) or names, with or without #')
      .action(run(async (names: string[], options) => {
        const client = await getWritableClient(options.profile, 'leave a channel');
        printSlackLeave(await client.leaveChannels(names), options.json);
      })),
    `Examples:

  agentio slack channels leave old-project team-offsite

Every channel is looked up first: one wrong name leaves none. Channels you
are not in are skipped. After leaving a private channel you no longer see it,
so only another member can invite you back.`,
  );

  addExamples(
    leaf(channels, 'members', 'List a channel\'s members')
      .argument('<channel>', 'Channel id (C…) or name, with or without #')
      .action(run(async (channel: string, options) => {
        const { client } = await getSlackClient(options.profile);
        const { channel: found, members } = await client.channelMembers(channel);
        printSlackChannelMembers(found, members, options.json);
      })),
    `Examples:

  agentio slack channels members team-design
  agentio slack channels members C012AB3CD --json | jq -r '.members[].email'`,
  );

  addExamples(
    leaf(channels, 'invite', 'Add people to a channel; Slack adds them at once, without asking them')
      .argument('<channel>', 'Channel id (C…) or name, with or without #')
      .argument('<users...>', 'User ids (U…) or email addresses')
      .action(run(async (channel: string, users: string[], options) => {
        const client = await getWritableClient(options.profile, 'invite to a channel');
        printSlackMembership(await client.inviteToChannel(channel, users), 'Invited', options.json);
      })),
    `Examples:

  agentio slack channels invite team-design jane@example.com U012AB3CD

Every user is looked up first: one unknown email invites nobody. People
already in the channel are skipped. You must be a member of the channel.`,
  );

  addExamples(
    leaf(channels, 'uninvite', 'Remove people from a channel')
      .argument('<channel>', 'Channel id (C…) or name, with or without #')
      .argument('<users...>', 'User ids (U…) or email addresses')
      .action(run(async (channel: string, users: string[], options) => {
        const client = await getWritableClient(options.profile, 'uninvite from a channel');
        printSlackMembership(await client.uninviteFromChannel(channel, users), 'Uninvited', options.json);
      })),
    `Examples:

  agentio slack channels uninvite team-design jane@example.com

Every user is looked up first: one unknown email removes nobody. People not
in the channel are skipped.`,
  );

  const canvases = slack.command('canvases').description('Canvases: read and write them as Markdown, share and delete them (needs a user token profile)');

  addExamples(
    leaf(canvases, 'list', 'List the canvases you can see, newest edit first')
      .option('--channel <channel>', 'Only this channel\'s canvas')
      .option('--mine', 'Only canvases you created')
      .action(run(async (options) => {
        const { client } = await getSlackClient(options.profile);
        printSlackCanvasList(await findCanvases(client, { channel: options.channel, mine: !!options.mine }), options.json);
      })),
    `Examples:

  agentio slack canvases list
  agentio slack canvases list --mine --json
  agentio slack canvases list --channel '#eng'`,
  );

  addExamples(
    leaf(canvases, 'get', 'Print a canvas as Markdown; what cannot be written back is listed on stderr')
      .argument('<canvas>', CANVAS_ARGUMENT)
      .action(run(async (canvas: string, options) => {
        const { client } = await getSlackClient(options.profile);
        printSlackCanvasContent(await readCanvas(client, canvas), options.json);
      })),
    `Examples:

  agentio slack canvases get F07ABC1234 > plan.md
  agentio slack canvases get https://example.slack.com/docs/T0123/F07ABC1234
  agentio slack canvases get '#eng' --json`,
  );

  addExamples(
    leaf(canvases, 'create', 'Create a canvas from Markdown (file or stdin)')
      .argument('[title]', 'Title of a standalone canvas')
      .argument('[file]', 'Markdown file; stdin when absent')
      .option('--channel <channel>', 'Create this channel\'s canvas instead; then give no title')
      .action(run(async (title: string | undefined, file: string | undefined, options) => {
        if (options.channel && file !== undefined) {
          throw new CliError('INVALID_PARAMS', 'A channel canvas takes no title', 'agentio slack canvases create --channel <channel> [file]');
        }
        if (!options.channel && !title?.trim()) {
          throw new CliError('INVALID_PARAMS', 'A title is required', 'agentio slack canvases create "<title>" [file]');
        }
        const markdown = await readMarkdown(options.channel ? title : file);
        const client = await getWritableClient(options.profile, 'create a canvas');
        const id = await client.createCanvas(markdown, options.channel
          ? { channelId: (await client.getChannel(options.channel)).id }
          : { title: title!.trim() });
        await reportCanvasChange(client, id, 'Created', options.json);
      })),
    `Examples:

  agentio slack canvases create "Release notes" notes.md
  echo "# Runbook" | agentio slack canvases create "Runbook"
  agentio slack canvases create --channel '#eng' plan.md`,
  );

  addExamples(
    leaf(canvases, 'set', 'Replace a canvas\'s whole content with Markdown (file or stdin)')
      .argument('<canvas>', CANVAS_ARGUMENT)
      .argument('[file]', 'Markdown file; stdin when absent')
      .option('--force', 'Allow empty content, which clears the canvas')
      .action(run(async (canvas: string, file: string | undefined, options) => {
        if (file === undefined && process.stdin.isTTY) {
          throw new CliError('INVALID_PARAMS', 'No Markdown was given', 'Give a Markdown file, or pipe Markdown on stdin');
        }
        const markdown = await readMarkdown(file);
        if (!markdown.trim() && !options.force) {
          throw new CliError('INVALID_PARAMS', 'The Markdown is empty, which would clear the canvas', 'Pass --force to clear it');
        }
        const client = await getWritableClient(options.profile, 'change a canvas');
        const id = await resolveCanvasId(client, canvas);
        await client.replaceCanvas(id, markdown);
        await reportCanvasChange(client, id, 'Updated', options.json);
      })),
    `Examples:

  agentio slack canvases get F07ABC1234 > plan.md
  # edit plan.md
  agentio slack canvases set F07ABC1234 plan.md

Parts listed by get as "can't be written back" (embedded files, layouts) are
replaced by what the Markdown says.`,
  );

  addExamples(
    leaf(canvases, 'rename', 'Change a canvas\'s title')
      .argument('<canvas>', CANVAS_ARGUMENT)
      .argument('<title>', 'New title')
      .action(run(async (canvas: string, title: string, options) => {
        if (!title.trim()) throw new CliError('INVALID_PARAMS', 'The title cannot be empty');
        const client = await getWritableClient(options.profile, 'rename a canvas');
        const id = await resolveCanvasId(client, canvas);
        await client.renameCanvas(id, title.trim());
        await reportCanvasChange(client, id, 'Renamed', options.json);
      })),
    `Examples:

  agentio slack canvases rename F07ABC1234 "Plan, v2"`,
  );

  addExamples(
    leaf(canvases, 'share', 'Give users or channels access to a canvas')
      .argument('<canvas>', CANVAS_ARGUMENT)
      .requiredOption('--to <targets...>', 'Users (U…, or email) and channels (#name, C…); comma-separated or repeated')
      .option('--level <level>', 'read, write or owner (default: read)')
      .action(run(async (canvas: string, options) => {
        const level = checkAccessLevel(options.level);
        const client = await getWritableClient(options.profile, 'share a canvas');
        const id = await resolveCanvasId(client, canvas);
        const targets = await resolveTargets(client, options.to);
        await client.setCanvasAccess(id, level, targets);
        await reportCanvasChange(client, id, `Shared (${level}) with ${describeTargets(targets)}:`, options.json);
      })),
    `Examples:

  agentio slack canvases share F07ABC1234 --to '#eng' --to alice@example.com
  agentio slack canvases share F07ABC1234 --to U012AB3CD --level write`,
  );

  addExamples(
    leaf(canvases, 'unshare', 'Remove users\' or channels\' access to a canvas')
      .argument('<canvas>', CANVAS_ARGUMENT)
      .requiredOption('--from <targets...>', 'Users (U…, or email) and channels (#name, C…); comma-separated or repeated')
      .action(run(async (canvas: string, options) => {
        const client = await getWritableClient(options.profile, 'unshare a canvas');
        const id = await resolveCanvasId(client, canvas);
        const targets = await resolveTargets(client, options.from);
        await client.removeCanvasAccess(id, targets);
        await reportCanvasChange(client, id, `Unshared from ${describeTargets(targets)}:`, options.json);
      })),
    `Examples:

  agentio slack canvases unshare F07ABC1234 --from '#eng'`,
  );

  addExamples(
    leaf(canvases, 'delete', 'Delete a canvas; this cannot be undone')
      .argument('<canvas>', CANVAS_ARGUMENT)
      .option('-y, --yes', 'Do not ask for confirmation')
      .action(run(async (canvas: string, options) => {
        if (!options.yes && !process.stdin.isTTY) {
          throw new CliError('INVALID_PARAMS', 'Deleting a canvas needs confirmation', 'Pass --yes to delete without a question');
        }
        const client = await getWritableClient(options.profile, 'delete a canvas');
        const id = await resolveCanvasId(client, canvas);
        const target = await client.canvasInfo(id);
        if (!options.yes && !(await confirm(`Delete canvas "${target.title || target.id}"? This cannot be undone`))) {
          console.error('Cancelled');
          return;
        }
        await client.deleteCanvas(id);
        printSlackCanvasChange(target, 'Deleted', options.json);
      })),
    `Examples:

  agentio slack canvases delete F07ABC1234
  agentio slack canvases delete F07ABC1234 --yes   # from a script`,
  );

  const profile = createProfileCommands<SlackCredentials>(slack, {
    service: 'slack',
    displayName: 'Slack',
    getExtraInfo: (credentials) => {
      if (credentials?.type === 'token') return ` - ${credentials.teamName ?? 'user token'} (token)`;
      return credentials?.channelName ? ` - #${credentials.channelName}` : ' - webhook';
    },
  });

  addExamples(
    profile
      .command('add')
      .description('Add a Slack profile: an incoming webhook, or a user token for the admin commands')
      .option('--token', 'Add a user token profile, without asking the profile type')
      .option('--profile <name>', 'Profile name (default: the channel name or workspace name)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(run(async (options: { token?: boolean; profile?: string; readOnly?: boolean }) => {
        const { token, ...rest } = options;
        // The token itself is always asked for, so it stays out of shell history.
        await addProfileWithSetup('slack', (o, context) => slackProfileAdd({ ...o, ...(token ? { kind: 'token' as const } : {}) }, context), rest);
      })),
    `Examples:

  # asks whether to add a webhook or a user token
  agentio slack profile add

  # a user token for the admin commands (users, channels)
  agentio slack profile add --token --profile work`,
  );
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
}

async function slackTokenProfileAdd(given: string | undefined, context: SetupContext): Promise<SetupResult<SlackTokenCredentials>> {
  if (given === undefined) {
    context.log('\nSlack User Token Setup\n');
    context.log('1. Go to https://api.slack.com/apps?new_app=1, click "Create an app", then "Blank app"');
    context.log('2. In OAuth & Permissions, add these User Token Scopes (not Bot Token Scopes):');
    context.log(`   ${SLACK_USER_SCOPES.join(', ')}`);
    context.log('3. Click "Install to Workspace", signed in as a workspace admin');
    context.log('4. Copy the User OAuth Token (starts with xoxp-)\n');
  }

  const token = checkUserToken(await answerOrAsk(context, SLACK_TOKEN_INPUT, given));
  const auth = await new SlackClient({ type: 'token', token }).authTest();

  return {
    credentials: { type: 'token', token, teamId: auth.teamId, teamName: auth.teamName, userName: auth.userName },
    suggestedProfileName: slugify(auth.teamName),
    info: `Signed in as ${auth.userName} in ${auth.teamName}. Test with: agentio slack users list`,
  };
}

export async function slackProfileAdd(
  options: SlackProfileAddOptions,
  context: SetupContext,
): Promise<SetupResult<SlackCredentials>> {
  const kind = options.token !== undefined ? 'token' : options.kind ?? await context.ask(SLACK_KIND_INPUT);
  if (kind === 'token') return slackTokenProfileAdd(options.token, context);

  context.log('\nSlack Webhook Setup\n');
  context.log('1. Go to https://api.slack.com/apps and create a new app (or use existing)');
  context.log('2. Enable "Incoming Webhooks" in Features');
  context.log('3. Click "Add New Webhook to Workspace" and select a channel');
  context.log('4. Copy the Webhook URL\n');

  const webhookUrl = await context.ask(SLACK_WEBHOOK_INPUT);

  await checkWebhookUrl(webhookUrl, {
    prefix: 'https://hooks.slack.com/',
    invalidMessage: 'Invalid Slack webhook URL',
    invalidSuggestion: 'URL should start with https://hooks.slack.com/',
    showResponseBody: true,
  }, context);

  const channelName = await context.ask(SLACK_CHANNEL_INPUT);

  const credentials: SlackWebhookCredentials = {
    type: 'webhook',
    webhookUrl,
    channelName: channelName || undefined,
  };

  return {
    credentials,
    suggestedProfileName: channelName || 'webhook',
    info: 'Test with: agentio slack send "Hello from agentio"',
  };
}
