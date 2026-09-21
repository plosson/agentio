import { defineServicePlugin } from '../types';
import { TelegramClient } from './client';
import { registerTelegramCommands, telegramProfileAdd } from './commands';
import type { TelegramCredentials } from './types';

export default defineServicePlugin<TelegramCredentials>()({
  apiVersion: 1,
  id: 'telegram',
  displayName: 'Telegram',
  description: 'Use when sending Telegram messages via the agentio CLI.',
  registerCommands: registerTelegramCommands,
  profile: {
    setup: telegramProfileAdd,
    createClient: (credentials) => new TelegramClient(credentials.botToken, credentials.channelId),
  },
});
