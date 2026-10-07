import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

export const CLAUDE_TOKEN_INPUT: InputSpec = {
  id: 'token', label: 'Token or API key', kind: 'secret',
  help: 'Run `claude setup-token` for your subscription, or create an API key at console.anthropic.com',
};
export const CLAUDE_MODEL_INPUT: InputSpec = { id: 'model', label: 'Default model', kind: 'text', required: false, help: 'Such as opus or sonnet; blank for Claude Code\'s default' };

/** What Claude setup needs: a token or key, and a default model if any. Nothing is signed in here. */
export const CLAUDE_SETUP_NEEDS: SetupNeeds = { inputs: [CLAUDE_TOKEN_INPUT, CLAUDE_MODEL_INPUT], auth: 'none' };
