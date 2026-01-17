import { Command } from 'commander';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { google } from 'googleapis';
import { getValidTokens, createGoogleAuth } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { performOAuthFlow } from '../auth/oauth';
import { GmailClient } from '../services/gmail/client';
import { printMessageList, printMessage, printSendResult, printArchived, printMarked, printAttachmentList, printAttachmentDownloaded, raw } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin, resolveProfileName } from '../utils/stdin';
import type { GmailAttachment } from '../types/gmail';

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
    .option('--profile <name>', 'Profile name')
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
    .command('get <message-id>')
    .description('Get a message')
    .option('--profile <name>', 'Profile name')
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
    .option('--profile <name>', 'Profile name')
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

  gmail
    .command('send')
    .description('Send an email')
    .option('--profile <name>', 'Profile name')
    .requiredOption('--to <email>', 'Recipient (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--cc <email>', 'CC recipient (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--bcc <email>', 'BCC recipient (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .requiredOption('--subject <subject>', 'Email subject')
    .option('--body <body>', 'Email body (or pipe via stdin)')
    .option('--html', 'Treat body as HTML')
    .option('--attachment <path>', 'File to attach (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--inline <cid:path>', 'Inline image (repeatable, format: contentId:filepath). Supports PNG, JPG, GIF only (not SVG)', (val, acc: string[]) => [...acc, val], [])
    .action(async (options) => {
      try {
        let body = options.body;

        // Check for stdin if no body provided
        if (!body) {
          body = await readStdin();
        }

        if (!body) {
          throw new CliError('INVALID_PARAMS', 'Body is required. Use --body or pipe via stdin.');
        }

        // Process regular attachments
        const regularAttachments: GmailAttachment[] = options.attachment.map((path: string) => ({
          path,
          filename: basename(path),
        }));

        // Process inline images (format: contentId:filepath)
        const inlineAttachments: GmailAttachment[] = options.inline.map((spec: string) => {
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

        // Combine attachments
        const attachments: GmailAttachment[] | undefined =
          regularAttachments.length || inlineAttachments.length
            ? [...regularAttachments, ...inlineAttachments]
            : undefined;

        const { client } = await getGmailClient(options.profile);
        const result = await client.send({
          to: options.to,
          cc: options.cc.length ? options.cc : undefined,
          bcc: options.bcc.length ? options.bcc : undefined,
          subject: options.subject,
          body,
          isHtml: options.html,
          attachments,
        });
        printSendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('reply')
    .description('Reply to a thread')
    .option('--profile <name>', 'Profile name')
    .requiredOption('--thread-id <id>', 'Thread ID')
    .option('--body <body>', 'Reply body (or pipe via stdin)')
    .option('--html', 'Treat body as HTML')
    .action(async (options) => {
      try {
        let body = options.body;

        if (!body) {
          body = await readStdin();
        }

        if (!body) {
          throw new CliError('INVALID_PARAMS', 'Body is required. Use --body or pipe via stdin.');
        }

        const { client } = await getGmailClient(options.profile);
        const result = await client.reply({
          threadId: options.threadId,
          body,
          isHtml: options.html,
        });
        printSendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('archive <message-id>')
    .description('Archive a message')
    .option('--profile <name>', 'Profile name')
    .action(async (messageId: string, options) => {
      try {
        const { client } = await getGmailClient(options.profile);
        await client.archive(messageId);
        printArchived(messageId);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('mark <message-id>')
    .description('Mark message as read or unread')
    .option('--profile <name>', 'Profile name')
    .option('--read', 'Mark as read')
    .option('--unread', 'Mark as unread')
    .action(async (messageId: string, options) => {
      try {
        if (!options.read && !options.unread) {
          throw new CliError('INVALID_PARAMS', 'Specify --read or --unread');
        }
        if (options.read && options.unread) {
          throw new CliError('INVALID_PARAMS', 'Cannot specify both --read and --unread');
        }

        const { client } = await getGmailClient(options.profile);
        await client.mark(messageId, options.read);
        printMarked(messageId, options.read);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('attachment <message-id>')
    .description('Download attachments from a message')
    .option('--profile <name>', 'Profile name')
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
    .command('export <message-id>')
    .description('Export a message as PDF')
    .option('--profile <name>', 'Profile name')
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
    .option('--profile <name>', 'Profile name', 'default')
    .action(async (options) => {
      try {
        const profileName = await resolveProfileName('gmail', options.profile);

        console.error(`Starting OAuth flow for Gmail profile "${profileName}"...`);

        const tokens = await performOAuthFlow('gmail');

        // Fetch the user's email to store with the profile
        const auth = createGoogleAuth(tokens);
        const gmailApi = google.gmail({ version: 'v1', auth });
        const userProfile = await gmailApi.users.getProfile({ userId: 'me' });
        const email = userProfile.data.emailAddress;

        await setProfile('gmail', profileName);
        await setCredentials('gmail', profileName, { ...tokens, email });

        console.log(`\nSuccess! Profile "${profileName}" for Gmail is now configured.`);
        if (email) {
          console.log(`   Email: ${email}`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
