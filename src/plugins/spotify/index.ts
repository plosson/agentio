import { defineServicePlugin } from '../types';
import { SpotifyClient } from './client';
import { registerSpotifyCommands, spotifyProfileAdd } from './commands';
import { reauthenticateSpotify, spotifyCredentialLifecycle } from './lifecycle';
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
    setup: spotifyProfileAdd,
    createClient: (credentials) => new SpotifyClient(credentials),
    describe: (credentials) => ({ account: credentials.displayName ?? credentials.userId }),
    reauthenticate: reauthenticateSpotify,
  },
  credentialLifecycle: spotifyCredentialLifecycle,
});
