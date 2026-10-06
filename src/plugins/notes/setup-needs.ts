import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

export const NOTES_URL_INPUT: InputSpec = { id: 'url', label: 'Notes server URL', kind: 'url', help: 'For example https://mac-mini.example.ts.net' };
export const NOTES_API_KEY_INPUT: InputSpec = { id: 'apiKey', label: 'API key', kind: 'secret', help: 'NOTES_API_KEY on the Mac that runs apple-notes-api' };

/** What Notes setup needs: the server's address and its key. No sign-in. */
export const NOTES_SETUP_NEEDS: SetupNeeds = { inputs: [NOTES_URL_INPUT, NOTES_API_KEY_INPUT], auth: 'none' };
