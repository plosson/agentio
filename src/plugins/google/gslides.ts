import { gslidesProfileAdd, registerGSlidesCommands } from '../../commands/gslides';
import { GSlidesClient } from '../../services/gslides/client';
import type { GSlidesCredentials } from '../../types/gslides';
import { defineServicePlugin } from '../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from './shared';

export default defineServicePlugin({
  apiVersion: 1,
  id: 'gslides',
  displayName: 'Google Slides',
  description: 'Use when interacting with Google Slides via the agentio CLI.',
  registerCommands: registerGSlidesCommands,
  profile: {
    add: gslidesProfileAdd,
    createClient: (credentials) => new GSlidesClient(credentials as GSlidesCredentials),
    reauthenticate: reauthenticateGoogleCamel('gslides'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
