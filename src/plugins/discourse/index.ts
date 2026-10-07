import { defineServicePlugin } from '../types';
import { DiscourseClient } from './client';
import { discourseProfileAdd, registerDiscourseCommands } from './commands';
import { DISCOURSE_SETUP_NEEDS } from './setup-needs';
import type { DiscourseCredentials } from './types';

export default defineServicePlugin<DiscourseCredentials>()({
  apiVersion: 1,
  id: 'discourse',
  displayName: 'Discourse',
  description: 'Use when interacting with Discourse forums via the agentio CLI.',
  registerCommands: registerDiscourseCommands,
  profile: {
    needs: DISCOURSE_SETUP_NEEDS,
    setup: discourseProfileAdd,
    createClient: (credentials) => new DiscourseClient(credentials),
    describe: (credentials) => ({ account: credentials.username, url: credentials.baseUrl }),
  },
});
