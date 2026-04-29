import { Command } from 'commander';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { getValidTokens, createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { performOAuthFlow } from '../auth/oauth';
import { GmailClient } from '../services/gmail/client';
import { printMessageList, printMessage, printSendResult, printDraftResult, printArchived, printMarked, printAttachmentList, printAttachmentDownloaded, printLabelList, printLabelCreated, printLabelDeleted, printLabelRenamed, printLabelModified, printBatchProgress, printBatchSummary, printBatchDryRun, printFilterList, printFilter, printFilterCreated, printFilterDeleted, raw } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import type { GmailAttachment, GmailSendOptions, GmailFilterCriteria, GmailFilterAction } from '../types/gmail';

function addComposeOptions(cmd: Command): Command {
  return cmd
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--to <email>', 'Recipient (repeatable, required unless --reply-to)', (val: string, acc: string[]) => [...acc, val], [])
    .option('--cc <email>', 'CC recipient (repeatable)', (val: string, acc: string[]) => [...acc, val], [])
    .option('--bcc <email>', 'BCC recipient (repeatable)', (val: string, acc: string[]) => [...acc, val], [])
    .option('--subject <subject>', 'Email subject (required unless --reply-to)')
    .option('--body <body>', 'Email body (or pipe via stdin)')
    .option('--html', 'Treat body as HTML')
    .option('--reply-to <thread-id>', 'Thread ID to reply to (derives to/subject from thread)')
    .option('--attachment <path>', 'File to attach (repeatable)', (val: string, acc: string[]) => [...acc, val], [])
    .option('--inline <cid:path>', 'Inline image (repeatable, format: contentId:filepath). Supports PNG, JPG, GIF only (not SVG)', (val: string, acc: string[]) => [...acc, val], []);
}

async function parseBody(body: string | undefined): Promise<string> {
  if (!body) {
    body = await readStdin() ?? undefined;
  }
  if (!body) {
    throw new CliError('INVALID_PARAMS', 'Body is required. Use --body or pipe via stdin.');
  }
  return body;
}

function parseAttachments(paths: string[]): GmailAttachment[] {
  return paths.map((path: string) => ({
    path,
    filename: basename(path),
  }));
}

function parseInlineAttachments(specs: string[]): GmailAttachment[] {
  return specs.map((spec: string) => {
    const colonIndex = spec.indexOf(':');
    if (colonIndex === -1) {
      throw new CliError('INVALID_PARAMS', `Invalid inline format: ${spec}`, 'Use format: contentId:filepath (e.g., logo:./logo.png)');
    }
    const contentId = spec.substring(0, colonIndex);
    const path = spec.substring(colonIndex + 1);
    return {
      path,
      filename: basename(path),
      contentId,
    };
  });
}

async function parseSendOptions(options: Record<string, unknown>): Promise<GmailSendOptions> {
  const replyTo = options.replyTo as string | undefined;
  const to = options.to as string[];
  const subject = options.subject as string | undefined;

  if (!replyTo) {
    if (!to.length) {
      throw new CliError('INVALID_PARAMS', '--to is required (unless using --reply-to)');
    }
    if (!subject) {
      throw new CliError('INVALID_PARAMS', '--subject is required (unless using --reply-to)');
    }
  }

  const body = await parseBody(options.body as string | undefined);

  const regularAttachments = parseAttachments(options.attachment as string[]);
  const inlineAttachments = parseInlineAttachments(options.inline as string[]);

  const attachments: GmailAttachment[] | undefined =
    regularAttachments.length || inlineAttachments.length
      ? [...regularAttachments, ...inlineAttachments]
      : undefined;

  return {
    to,
    cc: (options.cc as string[]).length ? options.cc as string[] : undefined,
    bcc: (options.bcc as string[]).length ? options.bcc as string[] : undefined,
    subject: subject || '',
    body,
    isHtml: options.html as boolean | undefined,
    attachments,
    replyTo,
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findChromePath(): string | null {
  const platform = process.platform;

  const paths: string[] = [];

  if (platform === 'darwin') {
    paths.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    );
  } else if (platform === 'linux') {
    paths.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
    );
  } else if (platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';

    paths.push(
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    );
  }

  for (const p of paths) {
    if (Bun.file(p).size > 0) {
      return p;
    }
  }

  return null;
}

async function getGmailClient(profileName?: string): Promise<{ client: GmailClient; profile: string }> {
  const { tokens, profile } = await getValidTokens('gmail', profileName);
  const auth = createGoogleAuth(tokens);
  return { client: new GmailClient(auth), profile };
}

async function collectIds(positional: string[]): Promise<string[]> {
  if (positional.length > 0) return positional;
  const stdin = await readStdin();
  if (!stdin) return [];
  return stdin.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

function parseChunkOpts(options: Record<string, unknown>): { chunkSize: number; maxRetries: number; dryRun: boolean } {
  const chunkSize = Math.min(Math.max(parseInt((options.chunkSize as string) ?? '1000', 10) || 1000, 1), 1000);
  const maxRetries = Math.max(parseInt((options.maxRetries as string) ?? '5', 10) || 0, 0);
  const dryRun = options.dryRun === true;
  return { chunkSize, maxRetries, dryRun };
}

async function buildLabelNamesById(client: GmailClient): Promise<Map<string, string>> {
  const labels = await client.listLabels();
  return new Map(labels.map((l) => [l.id, l.name]));
}

function parseFilterCriteriaFromOptions(options: Record<string, unknown>): GmailFilterCriteria {
  const criteria: GmailFilterCriteria = {};

  const from = options.from as string | undefined;
  const to = options.to as string | undefined;
  const subject = options.subject as string | undefined;
  const query = options.query as string | undefined;
  const negatedQuery = options.negatedQuery as string | undefined;
  const hasAttachment = options.hasAttachment === true;
  const excludeChats = options.excludeChats === true;
  const sizeRaw = options.size as string | undefined;
  const sizeComparison = options.sizeComparison as string | undefined;

  if (from) criteria.from = from;
  if (to) criteria.to = to;
  if (subject) criteria.subject = subject;
  if (query) criteria.query = query;
  if (negatedQuery) criteria.negatedQuery = negatedQuery;
  if (hasAttachment) criteria.hasAttachment = true;
  if (excludeChats) criteria.excludeChats = true;

  const sizeProvided = sizeRaw !== undefined;
  const cmpProvided = sizeComparison !== undefined;
  if (sizeProvided !== cmpProvided) {
    throw new CliError('INVALID_PARAMS', '--size and --size-comparison must be set together');
  }
  if (sizeProvided && cmpProvided) {
    if (sizeComparison !== 'larger' && sizeComparison !== 'smaller') {
      throw new CliError('INVALID_PARAMS', '--size-comparison must be "larger" or "smaller"');
    }
    const sizeNum = parseInt(sizeRaw!, 10);
    if (!Number.isFinite(sizeNum) || sizeNum < 0) {
      throw new CliError('INVALID_PARAMS', '--size must be a non-negative integer (bytes)');
    }
    criteria.size = sizeNum;
    criteria.sizeComparison = sizeComparison;
  }

  return criteria;
}

export function registerGmailCommands(program: Command): void {
  const gmail = program
    .command('gmail')
    .description('Gmail operations');

  addExamples(
    gmail
      .command('list')
      .description('List messages')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--limit <n>', 'Number of messages', '10')
      .option('--query <query>', 'Gmail search query (see "gmail search --help" for syntax)')
      .option('--label <label>', 'Filter by label (repeatable)', (val, acc: string[]) => [...acc, val], [])
      .action(async (options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const result = await client.list({
            limit: parseInt(options.limit, 10),
            query: options.query,
            labels: options.label.length ? options.label : undefined,
          });
          printMessageList(result.messages, result.total);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # 10 most recent messages
  agentio gmail list

  # 25 most recent in the inbox
  agentio gmail list --limit 25 --label INBOX

  # unread messages from the last week
  agentio gmail list --query "is:unread newer_than:7d"

  # use a specific profile
  agentio gmail list --profile alice@example.com`,
  );

  addExamples(
    gmail
      .command('get')
      .argument('<message-id>', 'Message ID')
      .description('Get a message')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Body format: text, html, or raw', 'text')
      .option('--body-only', 'Output only the message body')
      .action(async (messageId: string, options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const result = await client.get(messageId, options.format);
          if (options.bodyOnly) {
            raw(result.body);
          } else {
            printMessage(result);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # full message with headers
  agentio gmail get 18c4f1a2b3d

  # plain-text body only (good for piping to a file)
  agentio gmail get 18c4f1a2b3d --body-only > message.txt

  # raw HTML body
  agentio gmail get 18c4f1a2b3d --format html --body-only`,
  );

  addExamples(
    gmail
      .command('search')
      .description('Search messages using Gmail query syntax')
      .requiredOption('--query <query>', 'Search query')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--limit <n>', 'Max results (capped at 10000; >100 returns IDs only without per-message metadata)', '10')
      .option('--ids-only', 'Print one message ID per line (pipe-friendly into archive/label)')
      .action(async (options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const result = await client.search(options.query, parseInt(options.limit, 10));
          if (options.idsOnly) {
            for (const msg of result.messages) {
              console.log(msg.id);
            }
          } else {
            printMessageList(result.messages, result.total);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # unread mail from a specific sender in the last week
  agentio gmail search --query "from:alice@example.com is:unread newer_than:7d"

  # messages with attachments after a date
  agentio gmail search --query "has:attachment after:2024/01/01" --limit 25

  # subject keyword in inbox, excluding spam
  agentio gmail search --query "subject:invoice label:inbox -label:spam"

  # exact phrase across all mail
  agentio gmail search --query '"quarterly report"'

  # bulk pipe: archive everything matching a query
  agentio gmail search --query "from:noreply@example.com older_than:6m" --limit 5000 --ids-only \\
    | agentio gmail archive

Query syntax: from:, to:, cc:, subject:, label:, is:unread|starred|important,
has:attachment, after:YYYY/MM/DD, before:YYYY/MM/DD, newer_than:7d, older_than:1m.
Combine with spaces (AND), OR, or - to negate.`,
  );

  addExamples(
    addComposeOptions(gmail.command('send').description('Send an email'))
      .action(async (options) => {
        try {
          const sendOptions = await parseSendOptions(options);
          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'send email');
          const result = await client.send(sendOptions);
          printSendResult(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # plain-text email
  agentio gmail send --to alice@example.com --subject "Hello" --body "Hi Alice!"

  # body from stdin (great for piping)
  echo "Sent via pipe" | agentio gmail send --to alice@example.com --subject "Note"

  # reply within an existing thread (to/subject derived from thread)
  agentio gmail send --reply-to 18c4f1a2b3d --body "Thanks!"

  # HTML body with an attachment and an inline image
  agentio gmail send --to alice@example.com --cc bob@example.com \\
    --subject "Report" --html \\
    --body '<p>See chart:</p><img src="cid:chart1">' \\
    --attachment ./report.pdf --inline chart1:./chart.png`,
  );

  addExamples(
    addComposeOptions(gmail.command('draft').description('Create an email draft'))
      .action(async (options) => {
        try {
          const sendOptions = await parseSendOptions(options);
          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'create draft');
          const result = await client.draft(sendOptions);
          printDraftResult(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # save a draft for later editing in Gmail
  agentio gmail draft --to alice@example.com --subject "Hello" --body "Draft body"

  # draft a reply within an existing thread
  agentio gmail draft --reply-to 18c4f1a2b3d --body "Draft reply"

  # draft with attachment, body from stdin
  cat message.txt | agentio gmail draft --to alice@example.com \\
    --subject "Notes" --attachment ./notes.pdf`,
  );

  addExamples(
    gmail
      .command('archive')
      .argument('[message-id...]', 'Message ID(s) (or pipe one-per-line via stdin)')
      .description('Archive one or more messages (bulk-safe via batchModify)')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--chunk-size <n>', 'IDs per batchModify call (max 1000)', '1000')
      .option('--max-retries <n>', 'Retries per chunk on 429/5xx', '5')
      .option('--dry-run', 'Print chunk plan without calling the API')
      .action(async (messageIds: string[], options) => {
        try {
          const ids = await collectIds(messageIds);
          if (ids.length === 0) {
            throw new CliError('INVALID_PARAMS', 'No message IDs provided', 'Pass IDs as args or pipe via stdin');
          }
          const { chunkSize, maxRetries, dryRun } = parseChunkOpts(options);
          const totalChunks = Math.ceil(ids.length / chunkSize);

          if (dryRun) {
            printBatchDryRun('archive', {
              totalIds: ids.length,
              chunkSize,
              chunks: totalChunks,
              addLabels: [],
              removeLabels: ['INBOX'],
            });
            return;
          }

          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'archive email');

          if (ids.length === 1) {
            await client.archive(ids[0]);
            printArchived(ids[0]);
            return;
          }

          const result = await client.batchModify(ids, [], ['INBOX'], {
            chunkSize,
            maxRetries,
            onProgress: (p) => printBatchProgress('archive', p),
          });
          printBatchSummary('archive', result);
          if (result.failed.length) process.exit(5);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # archive one message
  agentio gmail archive 18c4f1a2b3d

  # archive several at once
  agentio gmail archive 18c4f1a2b3d 18c4f1a2b3e 18c4f1a2b3f

  # archive thousands by piping IDs from search (uses messages.batchModify, 1000/call)
  agentio gmail search --query "from:noreply@example.com older_than:1y" --limit 5000 --ids-only \\
    | agentio gmail archive

  # preview the chunk plan without calling the API
  echo "id1 id2 id3" | agentio gmail archive --dry-run`,
  );

  addExamples(
    gmail
      .command('mark')
      .argument('<message-id...>', 'Message ID(s)')
      .description('Mark one or more messages as read or unread')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--read', 'Mark as read')
      .option('--unread', 'Mark as unread')
      .action(async (messageIds: string[], options) => {
        try {
          if (!options.read && !options.unread) {
            throw new CliError('INVALID_PARAMS', 'Specify --read or --unread');
          }
          if (options.read && options.unread) {
            throw new CliError('INVALID_PARAMS', 'Cannot specify both --read and --unread');
          }

          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'mark email');
          for (const messageId of messageIds) {
            await client.mark(messageId, options.read);
            printMarked(messageId, options.read);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # mark one message as read
  agentio gmail mark 18c4f1a2b3d --read

  # mark several back to unread
  agentio gmail mark 18c4f1a2b3d 18c4f1a2b3e --unread`,
  );

  const labels = gmail
    .command('labels')
    .description('Manage Gmail labels');

  addExamples(
    labels
      .command('list')
      .description('List all labels')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const result = await client.listLabels();
          printLabelList(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # list every label (system + user)
  agentio gmail labels list

  # list labels for a specific profile
  agentio gmail labels list --profile alice@example.com`,
  );

  addExamples(
    labels
      .command('create')
      .argument('<name>', 'Label name (use "/" for nesting, e.g. "auto/receipts")')
      .description('Create a new label')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (name: string, options) => {
        try {
          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'create label');
          const result = await client.createLabel(name);
          printLabelCreated(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # create a top-level label
  agentio gmail labels create receipts

  # create a nested label (use "/" for hierarchy)
  agentio gmail labels create auto/receipts

  # nested two levels deep
  agentio gmail labels create work/clients/acme`,
  );

  addExamples(
    labels
      .command('delete')
      .argument('<name-or-id>', 'Label name or ID')
      .description('Delete a user label')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (nameOrId: string, options) => {
        try {
          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'delete label');
          const result = await client.deleteLabel(nameOrId);
          printLabelDeleted(result.name, result.id);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # delete a user label by name
  agentio gmail labels delete receipts

  # delete a nested label
  agentio gmail labels delete auto/receipts

  # delete by label ID
  agentio gmail labels delete Label_1234567890`,
  );

  addExamples(
    labels
      .command('rename')
      .argument('<old>', 'Existing label name or ID')
      .argument('<new>', 'New label name')
      .description('Rename a user label')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (oldName: string, newName: string, options) => {
        try {
          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'rename label');
          const result = await client.renameLabel(oldName, newName);
          printLabelRenamed(oldName, result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # rename a label
  agentio gmail labels rename receipts invoices

  # move a label into a nested hierarchy
  agentio gmail labels rename receipts auto/receipts`,
  );

  const filters = gmail
    .command('filters')
    .description('Manage Gmail filters');

  addExamples(
    filters
      .command('list')
      .description('List all filters')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const [filterList, labelNamesById] = await Promise.all([
            client.listFilters(),
            buildLabelNamesById(client),
          ]);
          printFilterList(filterList, labelNamesById);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # list every filter
  agentio gmail filters list

  # list filters for a specific profile
  agentio gmail filters list --profile alice@example.com`,
  );

  addExamples(
    filters
      .command('get')
      .argument('<id>', 'Filter ID')
      .description('Get a filter')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (id: string, options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const [filter, labelNamesById] = await Promise.all([
            client.getFilter(id),
            buildLabelNamesById(client),
          ]);
          printFilter(filter, labelNamesById);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # show full filter details
  agentio gmail filters get ANe1BmgABCDEF1234567890`,
  );

  addExamples(
    filters
      .command('create')
      .description('Create a Gmail filter')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--from <email>', 'Match sender')
      .option('--to <email>', 'Match recipient')
      .option('--subject <text>', 'Match subject text')
      .option('--query <q>', 'Gmail search query (same syntax as "gmail search")')
      .option('--negated-query <q>', 'Gmail search query that must NOT match')
      .option('--has-attachment', 'Match only messages with attachments')
      .option('--exclude-chats', 'Exclude chat messages')
      .option('--size <bytes>', 'Match by message size (paired with --size-comparison)')
      .option('--size-comparison <cmp>', 'Size comparison: larger|smaller (paired with --size)')
      .option('--apply <label>', 'Label to apply (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
      .option('--remove <label>', 'Label to remove (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
      .option('--forward <email>', 'Forward to a verified forwarding address')
      .action(async (options) => {
        try {
          const criteria = parseFilterCriteriaFromOptions(options);
          if (Object.keys(criteria).length === 0) {
            throw new CliError('INVALID_PARAMS', 'At least one criterion is required', 'Use --from, --to, --subject, --query, --negated-query, --has-attachment, --exclude-chats, or --size');
          }

          const apply = options.apply as string[];
          const remove = options.remove as string[];
          const forward = options.forward as string | undefined;
          if (!apply.length && !remove.length && !forward) {
            throw new CliError('INVALID_PARAMS', 'At least one action is required', 'Use --apply, --remove, or --forward');
          }

          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'create filter');

          const [addLabelIds, removeLabelIds] = await Promise.all([
            client.resolveLabelIds(apply),
            client.resolveLabelIds(remove),
          ]);

          const action: GmailFilterAction = {};
          if (addLabelIds.length) action.addLabelIds = addLabelIds;
          if (removeLabelIds.length) action.removeLabelIds = removeLabelIds;
          if (forward) action.forward = forward;

          const filter = await client.createFilter({ criteria, action });
          const labelNamesById = await buildLabelNamesById(client);
          printFilterCreated(filter, labelNamesById);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # apply a label to mail from a sender
  agentio gmail filters create --from noreply@example.com --apply Receipts

  # archive newsletters automatically
  agentio gmail filters create --from news@example.com --remove INBOX

  # complex criteria + multiple actions
  agentio gmail filters create \\
    --query "has:attachment subject:invoice" \\
    --apply Auto/Invoices --remove INBOX

  # forward all mail from a sender (forwarding address must be verified in Gmail settings)
  agentio gmail filters create --from boss@example.com --forward archive@me.com

  # size-based filter (5MB or larger)
  agentio gmail filters create --size 5000000 --size-comparison larger --apply Large`,
  );

  addExamples(
    gmail
      .command('label')
      .argument('[id...]', 'Message ID(s) (or thread ID(s) with --thread); pipe one-per-line via stdin')
      .description('Apply and/or remove labels on messages or threads (bulk-safe via batchModify)')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--apply <name>', 'Label to apply (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
      .option('--remove <name>', 'Label to remove (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
      .option('--thread', 'Treat IDs as thread IDs (expands to messages for batching)')
      .option('--chunk-size <n>', 'IDs per batchModify call (max 1000)', '1000')
      .option('--max-retries <n>', 'Retries per chunk on 429/5xx', '5')
      .option('--dry-run', 'Print chunk plan without calling the API')
      .action(async (ids: string[], options) => {
        try {
          const apply = options.apply as string[];
          const remove = options.remove as string[];
          if (!apply.length && !remove.length) {
            throw new CliError('INVALID_PARAMS', 'Specify at least one --apply or --remove');
          }

          const inputIds = await collectIds(ids);
          if (inputIds.length === 0) {
            throw new CliError('INVALID_PARAMS', 'No IDs provided', 'Pass IDs as args or pipe via stdin');
          }

          const isThread = options.thread === true;
          const { chunkSize, maxRetries, dryRun } = parseChunkOpts(options);

          if (dryRun) {
            if (isThread) {
              console.error(`would expand ${inputIds.length} thread(s) to messages; chunk count below assumes 1 message/thread`);
            }
            const estimated = inputIds.length;
            printBatchDryRun('label', {
              totalIds: estimated,
              chunkSize,
              chunks: Math.max(1, Math.ceil(estimated / chunkSize)),
              addLabels: apply,
              removeLabels: remove,
            });
            return;
          }

          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'modify labels');

          const [addLabelIds, removeLabelIds] = await Promise.all([
            client.resolveLabelIds(apply),
            client.resolveLabelIds(remove),
          ]);

          if (inputIds.length === 1 && !isThread) {
            await client.modifyLabels(inputIds[0], addLabelIds, removeLabelIds, false);
            printLabelModified(inputIds[0], false, apply, remove);
            return;
          }

          const messageIds = isThread
            ? await client.expandThreadsToMessages(inputIds, { maxRetries })
            : inputIds;

          if (isThread) {
            console.error(`expanded ${inputIds.length} thread(s) to ${messageIds.length} message(s)`);
          }

          if (messageIds.length === 0) {
            console.log('label: 0 message(s) to modify');
            return;
          }

          if (messageIds.length === 1) {
            await client.modifyLabels(messageIds[0], addLabelIds, removeLabelIds, false);
            printLabelModified(messageIds[0], false, apply, remove);
            return;
          }

          const result = await client.batchModify(messageIds, addLabelIds, removeLabelIds, {
            chunkSize,
            maxRetries,
            onProgress: (p) => printBatchProgress('label', p),
          });
          printBatchSummary('label', result);
          if (result.failed.length) process.exit(5);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # apply a label to one message
  agentio gmail label 18c4f1a2b3d --apply receipts

  # remove a label from several messages
  agentio gmail label 18c4f1a2b3d 18c4f1a2b3e --remove INBOX

  # archive (remove INBOX) and apply a label in one call
  agentio gmail label 18c4f1a2b3d --apply auto/receipts --remove INBOX

  # apply multiple labels to a thread
  agentio gmail label 18c4f1a2b3d --thread --apply important --apply work

  # bulk: pipe IDs from search and label them
  agentio gmail search --query "subject:invoice older_than:1y" --limit 5000 --ids-only \\
    | agentio gmail label --apply Archive/Invoices --remove INBOX

  # preview the chunk plan without calling the API
  echo "id1 id2 id3" | agentio gmail label --apply receipts --dry-run`,
  );

  addExamples(
    gmail
      .command('attachment')
      .argument('<message-id>', 'Message ID')
      .description('Download attachments from a message')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--name <filename>', 'Download specific attachment by filename (downloads all if not specified)')
      .option('--output <dir>', 'Output directory', '.')
      .action(async (messageId: string, options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const outputDir = options.output;

          // Download all attachments
          const results = await client.getAllAttachments(messageId);

          if (results.length === 0) {
            console.log('No attachments found');
            return;
          }

          // Filter by filename if specified
          const toDownload = options.name
            ? results.filter(({ attachment }) => attachment.filename === options.name)
            : results;

          if (toDownload.length === 0) {
            throw new CliError('NOT_FOUND', `Attachment not found: ${options.name}`);
          }

          if (toDownload.length > 1) {
            console.log(`Downloading ${toDownload.length} attachment(s)...\n`);
          }

          for (const { data, attachment } of toDownload) {
            const outputPath = join(outputDir, attachment.filename);
            await Bun.write(outputPath, data);
            printAttachmentDownloaded(attachment.filename, outputPath, data.length);
            if (toDownload.length > 1) console.log('');
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # download every attachment to the current directory
  agentio gmail attachment 18c4f1a2b3d

  # download all attachments to a specific folder
  agentio gmail attachment 18c4f1a2b3d --output ./downloads

  # download just one attachment by filename
  agentio gmail attachment 18c4f1a2b3d --name invoice.pdf --output ./downloads`,
  );

  const exportCmd = gmail
    .command('export')
    .argument('<message-id>', 'Message ID')
    .description('Export a message as PDF')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--output <path>', 'Output file path', 'message.pdf')
    .action(async (messageId: string, options) => {
      try {
        const { client } = await getGmailClient(options.profile);
        const message = await client.get(messageId, 'html');

        // Build HTML document - inject header before body content
        const emailHeader = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px 20px; margin-bottom: 16px; border-bottom: 1px solid #ddd; background: #f9f9f9;">
  <div style="font-size: 1.3em; font-weight: 600; margin-bottom: 12px;">${escapeHtml(message.subject)}</div>
  <div style="margin: 4px 0; font-size: 0.9em;"><strong>From:</strong> ${escapeHtml(message.from)}</div>
  <div style="margin: 4px 0; font-size: 0.9em;"><strong>To:</strong> ${escapeHtml(message.to.join(', '))}</div>
  <div style="margin: 4px 0; font-size: 0.9em;"><strong>Date:</strong> ${escapeHtml(message.date)}</div>
</div>`;

        let html: string;
        const body = message.body || '';

        // Check if body is already a full HTML document
        if (body.trim().toLowerCase().startsWith('<!doctype') || body.trim().toLowerCase().startsWith('<html')) {
          // Inject header after <body> tag
          html = body.replace(/<body[^>]*>/i, (match) => `${match}${emailHeader}`);
        } else {
          // Wrap fragment in minimal HTML
          html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
${emailHeader}
<div style="padding: 0 20px;">${body}</div>
</body>
</html>`;
        }

        // Find Chrome browser
        const chromePath = findChromePath();
        if (!chromePath) {
          throw new CliError(
            'NOT_FOUND',
            'Chrome/Chromium not found',
            'Install Google Chrome, Chromium, or Microsoft Edge'
          );
        }

        // Write HTML to temp file
        const tempHtml = join(tmpdir(), `agentio-email-${Date.now()}.html`);
        await Bun.write(tempHtml, html);

        // Resolve output path to absolute
        const outputPath = options.output.startsWith('/')
          ? options.output
          : join(process.cwd(), options.output);

        try {
          // Run Chrome in headless mode to generate PDF
          console.error('Generating PDF...');
          const result = Bun.spawnSync([
            chromePath,
            '--headless=new',
            '--disable-gpu',
            '--no-pdf-header-footer',
            `--print-to-pdf=${outputPath}`,
            tempHtml,
          ]);

          if (result.exitCode !== 0) {
            const stderr = result.stderr.toString();
            throw new CliError('API_ERROR', `Chrome failed: ${stderr}`);
          }

          console.log(`Exported to ${options.output}`);
        } finally {
          // Clean up temp file
          await Bun.file(tempHtml).unlink();
        }
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    exportCmd,
    `Examples:

  # export to default message.pdf in CWD
  agentio gmail export 18c4f1a2b3d

  # export to a specific path
  agentio gmail export 18c4f1a2b3d --output ./archive/invoice.pdf

Requires Chrome, Chromium, or Microsoft Edge installed locally.`,
  );

  // Profile management
  const profile = createProfileCommands<{ email?: string }>(gmail, {
    service: 'gmail',
    displayName: 'Gmail',
    getExtraInfo: (credentials) => credentials?.email ? ` - ${credentials.email}` : '',
  });

  profile
    .command('add')
    .description('Add a new Gmail profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await gmailProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function gmailProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
  console.error('Starting OAuth flow for Gmail...\n');

  const tokens = await performOAuthFlow('gmail');

  // Fetch the user's email to store with the profile
  let email: string;
  try {
    email = await fetchGoogleUserEmail(tokens.access_token);
  } catch (error) {
    throw new CliError('AUTH_FAILED', 'Could not fetch email from Gmail', 'Try again or specify --profile manually');
  }

  // Determine profile name: use explicit --profile, or email, or email-readonly if conflict
  let profileName: string;
  if (options.profile) {
    profileName = options.profile;
  } else if (options.readOnly && await getProfile('gmail', email)) {
    // Profile with email already exists, use -readonly suffix
    profileName = `${email}-readonly`;
  } else {
    profileName = email;
  }

  await setProfile('gmail', profileName, { readOnly: options.readOnly });
  await setCredentials('gmail', profileName, { ...tokens, email });

  console.log(`\nSuccess! Profile "${profileName}" configured.`);
  console.log(`   Email: ${email}`);
  if (options.readOnly) {
    console.log(`   Access: read-only`);
  }
}
