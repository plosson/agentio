import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from commands.ts, which reaches the plugin registry through the vault: importing this
// must not load the plugins.

export const SPOTIFY_CLIENT_ID_INPUT: InputSpec = {
  id: 'clientId',
  label: 'Client ID',
  kind: 'text',
  help: 'From your app at https://developer.spotify.com/dashboard (redirect URI http://127.0.0.1:3010/callback)',
};

/** Asked during the run with --no-browser, so not one of the setup inputs. */
export const REDIRECT_INPUT: InputSpec = { id: 'redirect', label: 'Address the browser was sent to (or just the code)', kind: 'text' };

/** What Spotify setup needs: your app's client ID, then a sign-in in the browser. */
export const SPOTIFY_SETUP_NEEDS: SetupNeeds = { inputs: [SPOTIFY_CLIENT_ID_INPUT], auth: 'browser' };
