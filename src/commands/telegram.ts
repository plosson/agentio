import { Command } from 'commander';
import { setCredentials } from '../auth/token-store';
import { setProfile, resolveProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { TelegramClient } from '../services/telegram/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt } from '../utils/stdin';
import { getDaemonClient, isDaemonAvailable } from '../daemon/client';
import { enforceWriteAccess } from '../utils/read-only';
import {
  printInboxMessageList,
  printInboxMessage,
  printInboxStats,
  printInboxAckResult,
  printInboxReplyResult,
  printOutboxMessageList,
  printOutboxMessage,
  printOutboxSendResult,
} from '../utils/output';
import type { TelegramCredentials, TelegramSendOptions } from '../types/telegram';

const getTelegramClient = createClientGetter<TelegramCredentials, TelegramClient>({
  service: 'telegram',
  createClient: (credentials) => new TelegramClient(credentials.botToken, credentials.channelId),
});

export function registerTelegramCommands(program: Command): void {
  const telegram = program
    .command('telegram')
    .description('Telegram operations');

  telegram
    .command('send')
    .description('Send a message to the channel')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--parse-mode <mode>', 'Message format: html or markdown')
    .option('--silent', 'Send without notification')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        let text = message;

        if (!text) {
          text = await readStdin() || undefined;
        }

        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const sendOptions: TelegramSendOptions = {};
        if (options.parseMode) {
          const mode = options.parseMode.toLowerCase();
          if (mode === 'html') sendOptions.parse_mode = 'HTML';
          else if (mode === 'markdown') sendOptions.parse_mode = 'MarkdownV2';
          else throw new CliError('INVALID_PARAMS', 'parse-mode must be "html" or "markdown"');
        }
        if (options.silent) {
          sendOptions.disable_notification = true;
        }

        const { client, profile } = await getTelegramClient(options.profile);
        await enforceWriteAccess('telegram', profile, 'send message');
        const result = await client.sendMessage(text, sendOptions);

        console.log('Message sent');
        console.log(`ID: ${result.message_id}`);
        console.log(`Chat: ${result.chat.title || result.chat.id}`);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<TelegramCredentials>(telegram, {
    service: 'telegram',
    displayName: 'Telegram',
    getExtraInfo: (credentials) => credentials?.channelName ? ` - ${credentials.channelName}` : '',
  });

  profile
    .command('add')
    .description('Add a new Telegram bot profile')
    .option('--profile <name>', 'Profile name (auto-detected from bot username if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        console.error('\nTelegram Bot Setup\n');

        // Step 1: Create bot
        console.error('Step 1: Create your bot');
        console.error('  Open Telegram and message @BotFather');
        console.error('  -> https://t.me/BotFather\n');
        console.error('  Send these commands:');
        console.error('    /newbot');
        console.error('    -> Enter a display name (e.g., "My Announcements Bot")');
        console.error('    -> Enter a username ending in "bot" (e.g., "my_announce_bot")\n');
        console.error('  BotFather will give you a token like:');
        console.error('    123456789:ABCdefGHIjklMNOpqrsTUVwxyz\n');

        const botToken = await prompt('? Paste your bot token: ');

        if (!botToken) {
          throw new CliError('INVALID_PARAMS', 'Bot token is required');
        }

        // Validate token
        const tempClient = new TelegramClient(botToken, '');
        let botInfo;
        try {
          botInfo = await tempClient.getMe();
        } catch (error) {
          if (error instanceof CliError && error.code === 'AUTH_FAILED') {
            throw new CliError('AUTH_FAILED', 'Invalid bot token. Please check and try again.');
          }
          throw error;
        }

        console.error(`\nBot verified: @${botInfo.username}\n`);

        // Step 2: Add bot to channel
        console.error('Step 2: Add bot to your channel');
        console.error('  1. Open your Telegram channel');
        console.error('  2. Go to Channel Settings -> Administrators');
        console.error(`  3. Add @${botInfo.username} as admin with "Post Messages" permission\n`);

        console.error('  How to find your channel ID:');
        console.error('  - Public channel: Use @username (e.g., @mychannel)');
        console.error('  - Private channel: Forward any message from the channel to @userinfobot');
        console.error('    The bot will reply with the channel ID (starts with -100)\n');

        const channelId = await prompt('? Enter channel ID: ');

        if (!channelId) {
          throw new CliError('INVALID_PARAMS', 'Channel ID is required');
        }

        // Validate channel access
        const client = new TelegramClient(botToken, channelId);
        let chatInfo;
        try {
          chatInfo = await client.getChat();
        } catch (error) {
          if (error instanceof CliError) {
            if (error.code === 'NOT_FOUND') {
              throw new CliError('NOT_FOUND', `Channel "${channelId}" not found. Check the channel ID or username.`);
            }
            if (error.code === 'PERMISSION_DENIED') {
              throw new CliError('PERMISSION_DENIED', `Bot cannot access "${channelId}". Make sure it's added as an admin.`);
            }
          }
          throw error;
        }

        const channelName = chatInfo.title || chatInfo.username || channelId;
        console.error(`\nChannel verified: ${channelName}`);
        console.error('Bot can post to this channel\n');

        // Step 3: Optional customization tips
        console.error('Step 3: Customize your bot (optional)');
        console.error('  You can set a profile photo and description in @BotFather:');
        console.error('    /setuserpic - Set bot photo');
        console.error('    /setdescription - Set bot description\n');

        // Auto-name based on bot username
        const profileName = options.profile || botInfo.username;

        // Save credentials
        const credentials: TelegramCredentials = {
          botToken: botToken,
          channelId: channelId,
          botUsername: botInfo.username,
          channelName: channelName,
        };

        await setProfile('telegram', profileName, { readOnly: options.readOnly });
        await setCredentials('telegram', profileName, credentials);

        console.log(`\nProfile "${profileName}" configured!`);
        if (options.readOnly) {
          console.log(`   Access: read-only`);
        }
        console.log(`   Test with: agentio telegram send --profile ${profileName} "Hello world"`);
      } catch (error) {
        handleError(error);
      }
    });

  // Inbox subcommands (requires daemon)
  const inbox = telegram.command('inbox').description('Inbox operations (requires daemon)');

  inbox
    .command('pull')
    .description('Get pending messages from inbox')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Maximum messages to retrieve', '50')
    .option('--status <status>', 'Filter by status: pending or done', 'pending')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('telegram', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No Telegram profiles configured', 'Run: agentio telegram profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        const client = await getDaemonClient();
        const messages = await client.inboxPull({
          service: 'telegram',
          profile: profileResult.profile,
          limit: parseInt(options.limit, 10),
          status: options.status as 'pending' | 'done',
        });
        printInboxMessageList(messages);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('get')
    .description('Get a specific inbox message')
    .argument('<id>', 'Message ID')
    .action(async (id: string) => {
      try {
        const client = await getDaemonClient();
        const message = await client.inboxGet(id);
        if (!message) {
          throw new CliError('NOT_FOUND', `Message not found: ${id}`);
        }
        printInboxMessage(message);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('ack')
    .description('Mark a message as done')
    .argument('<id>', 'Message ID')
    .action(async (id: string) => {
      try {
        const client = await getDaemonClient();
        const success = await client.inboxAck(id);
        printInboxAckResult(success, id);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('reply')
    .description('Reply to an inbox message')
    .argument('<id>', 'Message ID to reply to')
    .argument('[message]', 'Reply text (or pipe via stdin)')
    .action(async (id: string, message: string | undefined) => {
      try {
        let text = message;
        if (!text) {
          text = await readStdin() || undefined;
        }
        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const client = await getDaemonClient();
        // Get the inbox message to determine the profile for read-only check
        const inboxMessage = await client.inboxGet(id);
        if (inboxMessage) {
          await enforceWriteAccess('telegram', inboxMessage.profile, 'reply to message');
        }
        const result = await client.inboxReply(id, text);
        printInboxReplyResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('stats')
    .description('Get inbox statistics')
    .option('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('telegram', options.profile);
        const client = await getDaemonClient();
        const stats = await client.inboxStats({
          service: 'telegram',
          profile: profileResult.profile ?? undefined,
        });
        printInboxStats(stats);
      } catch (error) {
        handleError(error);
      }
    });

  // Outbox subcommands (requires daemon)
  const outbox = telegram.command('outbox').description('Outbox operations (requires daemon)');

  outbox
    .command('send')
    .description('Queue a message for sending')
    .option('--profile <name>', 'Profile name')
    .option('--to <chat-id>', 'Destination chat ID (required)')
    .option('--parse-mode <mode>', 'Message format: html or markdown')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        const profileResult = await resolveProfile('telegram', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No Telegram profiles configured', 'Run: agentio telegram profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        if (!options.to) {
          throw new CliError('INVALID_PARAMS', 'Destination chat ID is required. Use --to <chat-id>');
        }

        let text = message;
        if (!text) {
          text = await readStdin() || undefined;
        }
        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const metadata: Record<string, unknown> = {};
        if (options.parseMode) {
          const mode = options.parseMode.toLowerCase();
          if (mode === 'html') metadata.parse_mode = 'HTML';
          else if (mode === 'markdown') metadata.parse_mode = 'MarkdownV2';
          else throw new CliError('INVALID_PARAMS', 'parse-mode must be "html" or "markdown"');
        }

        await enforceWriteAccess('telegram', profileResult.profile, 'send message');
        const client = await getDaemonClient();
        const result = await client.outboxSend({
          service: 'telegram',
          profile: profileResult.profile,
          conversationId: options.to,
          content: text,
          metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        });
        printOutboxSendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  outbox
    .command('status')
    .description('Check send status of a message')
    .argument('<id>', 'Outbox message ID')
    .action(async (id: string) => {
      try {
        const client = await getDaemonClient();
        const message = await client.outboxStatus(id);
        if (!message) {
          throw new CliError('NOT_FOUND', `Message not found: ${id}`);
        }
        printOutboxMessage(message);
      } catch (error) {
        handleError(error);
      }
    });

  outbox
    .command('list')
    .description('List outbox messages')
    .option('--profile <name>', 'Profile name')
    .option('--status <status>', 'Filter by status: pending, sending, sent, or failed')
    .option('--limit <n>', 'Maximum messages to retrieve', '50')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('telegram', options.profile);
        const client = await getDaemonClient();
        const messages = await client.outboxList({
          service: 'telegram',
          profile: profileResult.profile ?? undefined,
          status: options.status as 'pending' | 'sending' | 'sent' | 'failed' | undefined,
          limit: parseInt(options.limit, 10),
        });
        printOutboxMessageList(messages);
      } catch (error) {
        handleError(error);
      }
    });
}
