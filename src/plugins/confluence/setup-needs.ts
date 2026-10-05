import type { SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: index.ts reads
// this while the plugins load, so it must not wait on a module that is still loading.

/** What Confluence setup needs: only an Atlassian sign-in in the browser. */
export const CONFLUENCE_SETUP_NEEDS: SetupNeeds = { inputs: [], auth: 'browser' };
