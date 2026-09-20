export interface SlackWebhookCredentials {
  type: 'webhook';
  webhookUrl: string;
  channelName?: string;
}

export type SlackCredentials = SlackWebhookCredentials;

export interface SlackSendOptions {
  text?: string;
  payload?: Record<string, unknown>;
}

export interface SlackSendResult {
  success: boolean;
  isJsonPayload?: boolean;
}
