import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

export const SLACK_WEBHOOK_INPUT: InputSpec = {
  id: 'webhookUrl', label: 'Webhook URL', kind: 'secret',
  help: 'From your Slack app: Incoming Webhooks, Add New Webhook to Workspace (https://api.slack.com/apps)',
};
export const SLACK_CHANNEL_INPUT: InputSpec = { id: 'channelName', label: 'Channel name', kind: 'text', required: false, help: 'Only for display; also the default profile name' };

/** What Slack setup needs: a webhook address and, for display, a channel name. No sign-in. */
export const SLACK_SETUP_NEEDS: SetupNeeds = { inputs: [SLACK_WEBHOOK_INPUT, SLACK_CHANNEL_INPUT], auth: 'none' };
