import type { InputSpec } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry: lifecycle.ts asks for the code too.

export const APP_KEY_INPUT: InputSpec = { label: 'App key', kind: 'text', help: 'From your app at https://www.dropbox.com/developers/apps (Settings tab)' };
export const CODE_INPUT: InputSpec = { label: 'Code Dropbox shows after you allow access', kind: 'secret' };
