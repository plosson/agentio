import { Command } from 'commander';
import { basename, join } from 'path';
import { google } from 'googleapis';
import { getValidTokens, createGoogleAuth } from '../auth/token-manager';
import { setCredentials, removeCredentials, getCredentials } from '../auth/token-store';
import { setProfile, removeProfile, listProfiles } from '../config/config-manager';
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

        // Process attachments
        const attachments: GmailAttachment[] | undefined = options.attachment.length
          ? options.attachment.map((path: string) => ({
              path,
              filename: basename(path),
            }))
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

        // Lazy load playwright-core to avoid bundling issues
        const { chromium } = await import('playwright-core');

        // Launch browser and generate PDF
        console.error('Launching browser...');
        const browser = await chromium.launch({
          channel: 'chrome', // Use system Chrome
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        await page.pdf({
          path: options.output,
          format: 'A4',
          margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
        });

        await browser.close();
        console.log(`Exported to ${options.output}`);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = gmail
    .command('profile')
    .description('Manage Gmail profiles');

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
        const gmail = google.gmail({ version: 'v1', auth });
        const userProfile = await gmail.users.getProfile({ userId: 'me' });
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

  profile
    .command('list')
    .description('List Gmail profiles')
    .action(async () => {
      try {
        const result = await listProfiles('gmail');
        const { profiles, default: defaultProfile } = result[0];

        if (profiles.length === 0) {
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials<{ email?: string }>('gmail', name);
            const emailInfo = credentials?.email ? ` - ${credentials.email}` : '';
            console.log(`${name}${marker}${emailInfo}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove a Gmail profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        const removed = await removeProfile('gmail', profileName);
        await removeCredentials('gmail', profileName);

        if (removed) {
          console.error(`Removed profile "${profileName}"`);
        } else {
          console.error(`Profile "${profileName}" not found`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
