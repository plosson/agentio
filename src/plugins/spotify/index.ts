import { defineServicePlugin } from '../types';
import { SpotifyClient } from './client';
import { registerSpotifyCommands, spotifyProfileAdd } from './commands';
import { reauthenticateSpotify, spotifyCredentialLifecycle } from './lifecycle';
import { SPOTIFY_SETUP_NEEDS } from './setup-needs';
import type { SpotifyCredentials } from './types';

export default defineServicePlugin<SpotifyCredentials>()({
  apiVersion: 1,
  id: 'spotify',
  displayName: 'Spotify',
  description:
    'Use when interacting with Spotify via the agentio CLI — search, playlists, library, history, and playback control.',
  brand: { url: 'https://open.spotify.com' },
  registerCommands: registerSpotifyCommands,
  profile: {
    needs: SPOTIFY_SETUP_NEEDS,
    setup: spotifyProfileAdd,
    createClient: (credentials) => new SpotifyClient(credentials),
    describe: (credentials) => ({ account: credentials.displayName ?? credentials.userId }),
    reauthenticate: (credentials, profileName, context) => reauthenticateSpotify(credentials, profileName, context),
  },
  credentialLifecycle: spotifyCredentialLifecycle,
});
