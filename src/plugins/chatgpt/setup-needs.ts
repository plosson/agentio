import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

export const CHATGPT_METHOD_INPUT: InputSpec = {
  id: 'method', label: 'Sign in with', kind: 'choice', default: 'chatgpt',
  choices: [{ value: 'chatgpt', label: 'ChatGPT account (subscription)' }, { value: 'apiKey', label: 'OpenAI API key' }],
};
/** Asked only for the API key method, so it is not among the needs. */
export const CHATGPT_API_KEY_INPUT: InputSpec = { id: 'apiKey', label: 'OpenAI API key', kind: 'secret', help: 'platform.openai.com → API keys' };
export const CHATGPT_MODEL_INPUT: InputSpec = { id: 'model', label: 'Default model', kind: 'text', required: false, help: 'Blank for Codex\'s default' };

export const CHATGPT_SETUP_NEEDS: SetupNeeds = { inputs: [CHATGPT_METHOD_INPUT, CHATGPT_MODEL_INPUT], auth: 'browser' };
