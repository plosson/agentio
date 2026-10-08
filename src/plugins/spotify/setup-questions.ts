import type { InputSpec } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry: oauth.ts asks for the redirect too.

export const SPOTIFY_CLIENT_ID_INPUT: InputSpec = {
  label: 'Client ID',
  kind: 'text',
  help: 'From your app at https://developer.spotify.com/dashboard (redirect URI http://127.0.0.1:3010/callback)',
};

/** Asked only with --no-browser. */
export const REDIRECT_INPUT: InputSpec = { label: 'Address the browser was sent to (or just the code)', kind: 'text' };
