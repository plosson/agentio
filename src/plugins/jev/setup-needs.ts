import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins.

export const JEV_API_KEY_INPUT: InputSpec = { id: 'apiKey', label: 'API key', kind: 'secret', help: 'console.typesafe.ai → Settings → Keys' };
export const JEV_MODEL_INPUT: InputSpec = { id: 'model', label: 'Default model', kind: 'text', required: false, help: 'Blank for jev-latest' };

/** What Jev setup needs: the API key, and a default model if any. No sign-in. */
export const JEV_SETUP_NEEDS: SetupNeeds = { inputs: [JEV_API_KEY_INPUT, JEV_MODEL_INPUT], auth: 'none' };
