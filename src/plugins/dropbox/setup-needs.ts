import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: lifecycle.ts asks
// for the code too, and importing these must not load the plugins half-initialised.

export const APP_KEY_INPUT: InputSpec = { id: 'appKey', label: 'App key', kind: 'text', help: 'From your app at https://www.dropbox.com/developers/apps (Settings tab)' };
export const CODE_INPUT: InputSpec = { id: 'code', label: 'Code Dropbox shows after you allow access', kind: 'secret' };

/** What Dropbox setup needs: your app's key, then the code Dropbox shows in the browser. */
export const DROPBOX_SETUP_NEEDS: SetupNeeds = { inputs: [APP_KEY_INPUT], auth: 'browser-code' };
