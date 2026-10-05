import type { SetupNeeds } from '../../plugin-sdk';

// Kept apart from the command files, which reach the plugin registry through the vault: index.ts reads
// these while the plugins load, so they must not wait on a module that is still loading.

/** What a Google sign-in needs: only the browser. */
export const GOOGLE_SETUP_NEEDS: SetupNeeds = { inputs: [], auth: 'browser' };
