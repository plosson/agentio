import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

// The URL is a secret (anyone with it can page you), so it is `secret`, not `url`; parsePagerUrl checks its shape.
export const PAGERIO_URL_INPUT: InputSpec = { id: 'url', label: 'Pager URL', kind: 'secret', help: 'The Copy button on https://pagerio.chuut.com' };

/** What Pocket Pager setup needs: the pager's URL. No sign-in. */
export const PAGERIO_SETUP_NEEDS: SetupNeeds = { inputs: [PAGERIO_URL_INPUT], auth: 'none' };
