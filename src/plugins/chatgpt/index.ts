import { defineServicePlugin } from '../types';
import { ChatGptClient } from './client';
import { chatGptProfileAdd, registerChatGptCommands } from './commands';
import { chatGptCredentialLifecycle, reauthenticateChatGpt } from './lifecycle';
import type { ChatGptCredentials } from './types';

export default defineServicePlugin<ChatGptCredentials>()({
  apiVersion: 1,
  id: 'chatgpt',
  displayName: 'ChatGPT',
  description: 'Use when an agent wants a second opinion or a sub-task answered by ChatGPT, through the codex CLI with a sign-in or key from the agentio vault.',
  brand: { url: 'https://chatgpt.com' },
  registerCommands: registerChatGptCommands,
  profile: {
    setup: chatGptProfileAdd,
    createClient: (credentials) => new ChatGptClient(credentials),
    describe: (credentials) => ({
      account: [credentials.kind === 'apiKey' ? 'API key' : credentials.email, credentials.model].filter(Boolean).join(' · ') || undefined,
    }),
    reauthenticate: reauthenticateChatGpt,
  },
  credentialLifecycle: chatGptCredentialLifecycle,
});
