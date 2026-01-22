import { Command } from 'commander';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { TelegramClient } from '../services/telegram/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt } from '../utils/stdin';
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
    .requiredOption('--profile <name>', 'Profile name')
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

        const { client } = await getTelegramClient(options.profile);
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

        await setProfile('telegram', profileName);
        await setCredentials('telegram', profileName, credentials);

        console.log(`\nProfile "${profileName}" configured!`);
        console.log(`   Test with: agentio telegram send --profile ${profileName} "Hello world"`);
      } catch (error) {
        handleError(error);
      }
    });
}
