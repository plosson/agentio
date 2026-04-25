import type { Model, PermissionMode } from './schedule';

export interface BotConfig {
  /** When false, inbound messages are stored but no Claude is spawned. */
  enabled: boolean;
  /** Claude model to use. */
  model: Model;
  /** Claude permission mode. `bypassPermissions` is required for fully-automated bots. */
  permissionMode: PermissionMode;
  /** Optional content appended via --append-system-prompt on every turn. */
  systemPrompt?: string;
  /** Working directory passed to `claude`. Defaults to ~/.config/agentio/bot-cwd. */
  cwd?: string;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
};
