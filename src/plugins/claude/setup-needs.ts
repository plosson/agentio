import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

/** Asked in a terminal only, when `claude` is installed; never part of `--describe`. */
export const CLAUDE_CREATE_TOKEN_INPUT: InputSpec = {
  id: 'createToken', label: 'How do you want to add Claude?', kind: 'choice', default: 'setupToken',
  choices: [
    { value: 'setupToken', label: 'Create a subscription token now (runs claude setup-token)' },
    { value: 'paste', label: 'Paste a token or API key I already have' },
  ],
};
export const CLAUDE_TOKEN_INPUT: InputSpec = {
  id: 'token', label: 'Token or API key', kind: 'secret',
  help: 'Run `claude setup-token` for your subscription, or create an API key at console.anthropic.com',
};
export const CLAUDE_MODEL_INPUT: InputSpec = { id: 'model', label: 'Default model', kind: 'text', required: false, help: 'Such as opus or sonnet; blank for Claude Code\'s default' };

/** What Claude setup needs: a token or key, and a default model if any. Nothing is signed in here. */
export const CLAUDE_SETUP_NEEDS: SetupNeeds = { inputs: [CLAUDE_TOKEN_INPUT, CLAUDE_MODEL_INPUT], auth: 'none' };
