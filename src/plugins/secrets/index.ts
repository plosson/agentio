import { defineServicePlugin } from '../types';
import { secretCount, SecretsClient } from './client';
import { registerSecretsCommands, secretsProfileAdd } from './commands';
import { valuesOf } from './store';
import type { SecretsCredentials } from './types';

export default defineServicePlugin<SecretsCredentials>()({
  apiVersion: 1,
  id: 'secrets',
  displayName: 'Secrets',
  description: 'Use when a script or agent needs a stored secret (a password, an API key) by name, or a command run with secrets as environment variables, via the agentio CLI.',
  registerCommands: registerSecretsCommands,
  profile: {
    setup: secretsProfileAdd,
    createClient: (credentials) => new SecretsClient(credentials),
    // A count only: the names can say too much about what the profile unlocks.
    describe: (credentials) => ({ account: secretCount(valuesOf(credentials).size) }),
  },
});
