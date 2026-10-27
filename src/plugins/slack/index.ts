import { defineServicePlugin } from '../types';
import { SlackClient } from './client';
import { registerSlackCommands, slackProfileAdd } from './commands';
import type { SlackCredentials } from './types';

const slack = defineServicePlugin<SlackCredentials>()({
  apiVersion: 1,
  id: 'slack',
  displayName: 'Slack',
  description: 'Use when sending or reading Slack messages, downloading files shared in Slack, looking up workspace members, or creating and managing channels and their members, via the agentio CLI.',
  brand: { url: 'https://app.slack.com' },
  registerCommands: registerSlackCommands,
  profile: {
    setup: slackProfileAdd,
    createClient: (credentials) => new SlackClient(credentials),
    describe: (credentials) => ({
      account: credentials.type === 'token' ? [credentials.userName, credentials.teamName].filter(Boolean).join(' @ ') : credentials.channelName,
    }),
  },
});

export default slack;
export { SlackClient } from './client';
export { registerSlackCommands, slackProfileAdd } from './commands';
export * from './output';
export type * from './types';
