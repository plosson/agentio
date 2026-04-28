import { Command } from 'commander';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { getValidTokens, createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { performOAuthFlow } from '../auth/oauth';
import { GmailClient } from '../services/gmail/client';
import { printMessageList, printMessage, printSendResult, printDraftResult, printArchived, printMarked, printAttachmentList, printAttachmentDownloaded, printLabelList, printLabelCreated, printLabelDeleted, printLabelRenamed, printLabelModified, raw } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';
import type { GmailAttachment, GmailSendOptions } from '../types/gmail';

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

export function registerGmailCommands(program: Command): void {
  const gmail = program
    .command('gmail')
    .description('Gmail operations');

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
    });

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
    });

  gmail
    .command('search')
    .description('Search messages using Gmail query syntax')
    .requiredOption('--query <query>', 'Search query')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--limit <n>', 'Max results', '10')
    .addHelpText('after', `
Query Syntax Examples:

  Keywords:
    --query "meeting agenda"          Messages containing both words
    --query "exact phrase"            Messages with exact phrase

  From/To:
    --query "from:john@example.com"   Messages from specific sender
    --query "to:me"                   Messages sent to you
    --query "from:john to:jane"       Combine sender and recipient
    --query "cc:team@example.com"     Messages where someone was CC'd

  Date Ranges:
    --query "after:2024/01/01"        Messages after date (YYYY/MM/DD)
    --query "before:2024/12/31"       Messages before date
    --query "after:2024/01/01 before:2024/06/30"   Date range
    --query "newer_than:7d"           Last 7 days (d=days, m=months, y=years)
    --query "older_than:1m"           Older than 1 month

  Labels:
    --query "label:inbox"             Messages in inbox
    --query "label:important"         Important messages
    --query "label:work"              Custom label (use exact label name)
    --query "-label:spam"             Exclude spam (- negates)

  Status:
    --query "is:unread"               Unread messages
    --query "is:starred"              Starred messages
    --query "is:important"            Marked as important
    --query "has:attachment"          Messages with attachments

  Subject:
    --query "subject:invoice"         Search in subject only

  Combined:
    --query "from:boss@work.com is:unread newer_than:7d"
    --query "has:attachment from:client after:2024/01/01"
`)
    .action(async (options) => {
      try {
        const { client } = await getGmailClient(options.profile);
        const result = await client.search(options.query, parseInt(options.limit, 10));
        printMessageList(result.messages, result.total);
      } catch (error) {
        handleError(error);
      }
    });

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
    });

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
    });

  gmail
    .command('archive')
    .argument('<message-id...>', 'Message ID(s)')
    .description('Archive one or more messages')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (messageIds: string[], options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        await enforceWriteAccess('gmail', profile, 'archive email');
        for (const messageId of messageIds) {
          await client.archive(messageId);
          printArchived(messageId);
        }
      } catch (error) {
        handleError(error);
      }
    });

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
    });

  const labels = gmail
    .command('labels')
    .description('Manage Gmail labels');

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
    });

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
    });

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
    });

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
    });

  gmail
    .command('label')
    .argument('<id...>', 'Message ID(s) (or thread ID(s) with --thread)')
    .description('Apply and/or remove labels on messages or threads')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--apply <name>', 'Label to apply (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
    .option('--remove <name>', 'Label to remove (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
    .option('--thread', 'Treat IDs as thread IDs')
    .action(async (ids: string[], options) => {
      try {
        const apply = options.apply as string[];
        const remove = options.remove as string[];
        if (!apply.length && !remove.length) {
          throw new CliError('INVALID_PARAMS', 'Specify at least one --apply or --remove');
        }

        const { client, profile } = await getGmailClient(options.profile);
        await enforceWriteAccess('gmail', profile, 'modify labels');

        const [addLabelIds, removeLabelIds] = await Promise.all([
          client.resolveLabelIds(apply),
          client.resolveLabelIds(remove),
        ]);

        const isThread = options.thread === true;
        for (const id of ids) {
          await client.modifyLabels(id, addLabelIds, removeLabelIds, isThread);
          printLabelModified(id, isThread, apply, remove);
        }
      } catch (error) {
        handleError(error);
      }
    });

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
    });

  gmail
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
