export interface SlackWebhookCredentials {
  type: 'webhook';
  webhookUrl: string;
  channelName?: string; // Optional metadata for display
}

export type SlackCredentials = SlackWebhookCredentials;

export interface SlackSendOptions {
  text?: string;
  payload?: Record<string, unknown>; // Raw JSON payload for Block Kit messages
}

export interface SlackSendResult {
  success: boolean;
  isJsonPayload?: boolean;
}
