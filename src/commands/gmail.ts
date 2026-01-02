import { Command } from 'commander';
import { basename } from 'path';
import { getValidTokens, createGoogleAuth } from '../auth/token-manager';
import { GmailClient } from '../services/gmail/client';
import { success, raw } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import type { GmailAttachment } from '../types/gmail';

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
    .option('--query <query>', 'Search query')
    .option('--label <label>', 'Filter by label (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .action(async (options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.list({
          limit: parseInt(options.limit, 10),
          query: options.query,
          labels: options.label.length ? options.label : undefined,
        });
        success('gmail', 'list', profile, result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('get <message-id>')
    .description('Get a message')
    .option('--profile <name>', 'Profile name')
    .option('--format <format>', 'Body format: text, html, or raw', 'text')
    .option('--body-only', 'Output only the body as plain text (no JSON wrapper)')
    .action(async (messageId: string, options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.get(messageId, options.format);
        if (options.bodyOnly) {
          raw(result.body);
        } else {
          success('gmail', 'get', profile, result);
        }
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('search')
    .description('Search messages')
    .requiredOption('--query <query>', 'Search query')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Max results', '10')
    .action(async (options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.search(options.query, parseInt(options.limit, 10));
        success('gmail', 'search', profile, result);
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

        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.send({
          to: options.to,
          cc: options.cc.length ? options.cc : undefined,
          bcc: options.bcc.length ? options.bcc : undefined,
          subject: options.subject,
          body,
          isHtml: options.html,
          attachments,
        });
        success('gmail', 'send', profile, result);
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

        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.reply({
          threadId: options.threadId,
          body,
          isHtml: options.html,
        });
        success('gmail', 'reply', profile, result);
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
        const { client, profile } = await getGmailClient(options.profile);
        await client.archive(messageId);
        success('gmail', 'archive', profile, { messageId, archived: true });
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

        const { client, profile } = await getGmailClient(options.profile);
        await client.mark(messageId, options.read);
        success('gmail', 'mark', profile, {
          messageId,
          read: options.read,
        });
      } catch (error) {
        handleError(error);
      }
    });
}
