import { GOOGLE_SETUP_NEEDS } from '../setup-needs';
import { gscriptProfileAdd, registerGScriptCommands } from './commands';
import { GScriptClient } from './client';
import type { GScriptCredentials } from './types';
import type { GoogleCamelTokens } from '../tokens';
import { defineServicePlugin } from '../../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from '../shared';

export default defineServicePlugin<GScriptCredentials, GoogleCamelTokens>()({
  apiVersion: 1,
  id: 'gscript',
  displayName: 'Google Apps Script',
  description: 'Use when interacting with Google Apps Script via the agentio CLI.',
  brand: { url: 'https://script.google.com' },
  registerCommands: registerGScriptCommands,
  profile: {
    setup: gscriptProfileAdd,
    needs: GOOGLE_SETUP_NEEDS,
    createClient: (credentials) => new GScriptClient(credentials),
    describe: (credentials) => ({ account: credentials.email }),
    reauthenticate: reauthenticateGoogleCamel<GScriptCredentials>('gscript'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
