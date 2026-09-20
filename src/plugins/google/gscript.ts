import { gscriptProfileAdd, registerGScriptCommands } from '../../commands/gscript';
import { GScriptClient } from '../../services/gscript/client';
import type { GScriptCredentials } from '../../types/gscript';
import { defineServicePlugin } from '../types';
import { googleCamelCredentialLifecycle, reauthenticateGoogleCamel } from './shared';

export default defineServicePlugin({
  apiVersion: 1,
  id: 'gscript',
  displayName: 'Google Apps Script',
  description: 'Use when interacting with Google Apps Script via the agentio CLI.',
  registerCommands: registerGScriptCommands,
  profile: {
    add: gscriptProfileAdd,
    createClient: (credentials) => new GScriptClient(credentials as GScriptCredentials),
    reauthenticate: reauthenticateGoogleCamel('gscript'),
  },
  credentialLifecycle: googleCamelCredentialLifecycle,
});
