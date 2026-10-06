import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

export const POCKETALERT_API_KEY_INPUT: InputSpec = { id: 'apiKey', label: 'API key', kind: 'secret', help: 'Settings in the Pocket Alert app' };

/** What Pocket Alert setup needs: the API key. No sign-in. */
export const POCKETALERT_SETUP_NEEDS: SetupNeeds = { inputs: [POCKETALERT_API_KEY_INPUT], auth: 'none' };
