import { gcalProfileAdd, registerGCalCommands } from './commands';
import { GCalClient } from './client';
import type { GCalCredentials } from './types';
import type { OAuthTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleAuthFromSnakeCredentials, googleSnakeCredentialLifecycle, reauthenticateGoogle } from '../shared';

export default defineServicePlugin<GCalCredentials, OAuthTokens>()({
  apiVersion: 1,
  id: 'gcal',
  displayName: 'Google Calendar',
  description: 'Use when interacting with Google Calendar via the agentio CLI.',
  brand: { url: 'https://calendar.google.com' },
  registerCommands: registerGCalCommands,
  profile: {
    setup: gcalProfileAdd,
    createClient: (credentials) => new GCalClient(googleAuthFromSnakeCredentials(credentials)),
    describe: (credentials) => ({ account: credentials.email }),
    reauthenticate: reauthenticateGoogle<GCalCredentials>('gcal'),
  },
  credentialLifecycle: googleSnakeCredentialLifecycle,
});
