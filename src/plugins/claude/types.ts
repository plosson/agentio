export type ClaudeTokenKind = 'oauth' | 'apiKey';

export interface ClaudeCredentials {
  /** A `claude setup-token` token (sk-ant-oat…) or an Anthropic API key (sk-ant-api…). Only `claude` ever receives it. */
  token: string;
  kind: ClaudeTokenKind;
  /** Default model, such as `opus`; Claude Code's default when absent. */
  model?: string;
}
