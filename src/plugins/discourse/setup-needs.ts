import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing these
// must not load the plugins (a test, or a future caller, could otherwise meet them half-initialised).

export const DISCOURSE_URL_INPUT: InputSpec = { id: 'url', label: 'Forum URL', kind: 'url', help: 'For example https://meta.discourse.org' };
export const DISCOURSE_API_KEY_INPUT: InputSpec = { id: 'apiKey', label: 'API key', kind: 'secret', help: 'Create one in your forum\'s admin, API keys (/admin/api/keys)' };
export const DISCOURSE_USERNAME_INPUT: InputSpec = { id: 'username', label: 'Username', kind: 'text', help: 'The user the API key acts as' };

/** What Discourse setup needs: the forum's address, an API key and the user it acts as. No sign-in. */
export const DISCOURSE_SETUP_NEEDS: SetupNeeds = { inputs: [DISCOURSE_URL_INPUT, DISCOURSE_API_KEY_INPUT, DISCOURSE_USERNAME_INPUT], auth: 'none' };
