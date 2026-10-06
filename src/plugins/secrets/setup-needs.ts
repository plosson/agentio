import type { SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing this
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

/** What Secrets setup needs: nothing. A new profile is empty; values come from `set` and `import`. */
export const SECRETS_SETUP_NEEDS: SetupNeeds = { inputs: [], auth: 'none' };
