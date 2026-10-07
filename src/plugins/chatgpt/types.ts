/**
 * A ChatGPT sign-in (`kind: 'chatgpt'`, refreshed by agentio) or an OpenAI API key. One shape with
 * optional fields, so `secretFields` can name `refreshToken`.
 */
export interface ChatGptCredentials {
  kind: 'chatgpt' | 'apiKey';
  apiKey?: string;
  accessToken?: string;
  /** Rotates on every refresh; never given to codex or to a remote agent. */
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  email?: string;
  /** Milliseconds since the epoch. */
  expiresAt?: number;
  model?: string;
}

/** What auth.openai.com's token endpoint returns. */
export interface OpenAiTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
}
