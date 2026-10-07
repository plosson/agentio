import { defineServicePlugin } from '../types';
import { ClaudeClient } from './client';
import { claudeProfileAdd, registerClaudeCommands } from './commands';
import { CLAUDE_SETUP_NEEDS } from './setup-needs';
import type { ClaudeCredentials } from './types';

export default defineServicePlugin<ClaudeCredentials>()({
  apiVersion: 1,
  id: 'claude',
  displayName: 'Claude',
  description: 'Use when an agent wants a second opinion or a sub-task answered by Claude, through the claude CLI with a token from the agentio vault.',
  brand: { url: 'https://claude.ai' },
  registerCommands: registerClaudeCommands,
  profile: {
    needs: CLAUDE_SETUP_NEEDS,
    setup: claudeProfileAdd,
    createClient: (credentials) => new ClaudeClient(credentials),
    describe: (credentials) => ({
      account: [credentials.kind === 'oauth' ? 'subscription' : 'API key', credentials.model].filter(Boolean).join(' · '),
    }),
  },
});
