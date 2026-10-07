import type { SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing this
// must not load the plugins.

/** What GitHub setup needs: a sign-in in the browser, nothing else. */
export const GITHUB_SETUP_NEEDS: SetupNeeds = { inputs: [], auth: 'browser' };
