import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

export const URL_INPUT: InputSpec = { id: 'url', label: 'Kite server URL', kind: 'url', help: 'For example https://kite.example.com' };

/** What Kite setup needs: the server's address, then a sign-in in the browser with a code. */
export const KITE_SETUP_NEEDS: SetupNeeds = { inputs: [URL_INPUT], auth: 'device-code' };
