import { defineServicePlugin } from '../types';
import { SlackClient } from './client';
import { registerSlackCommands, slackProfileAdd } from './commands';
import type { SlackCredentials } from './types';

const slack = defineServicePlugin<SlackCredentials>()({
  apiVersion: 1,
  id: 'slack',
  displayName: 'Slack',
  description: 'Use when sending Slack messages via the agentio CLI.',
  registerCommands: registerSlackCommands,
  profile: {
    setup: slackProfileAdd,
    createClient: (credentials) => new SlackClient(credentials),
  },
});

export default slack;
export { SlackClient } from './client';
export { registerSlackCommands, slackProfileAdd } from './commands';
export * from './output';
export type * from './types';
