import { defineServicePlugin } from '../types';
import { SecretsClient } from './client';
import { registerSecretsCommands, secretsProfileAdd } from './commands';
import { SECRETS_SETUP_NEEDS } from './setup-needs';
import { secretCount } from './store';
import type { SecretsCredentials } from './types';

export default defineServicePlugin<SecretsCredentials>()({
  apiVersion: 1,
  id: 'secrets',
  displayName: 'Secrets',
  description: 'Use when a script or agent needs a stored secret (a password, an API key) by name, or a command run with secrets as environment variables, via the agentio CLI.',
  registerCommands: registerSecretsCommands,
  profile: {
    needs: SECRETS_SETUP_NEEDS,
    setup: secretsProfileAdd,
    createClient: (credentials) => new SecretsClient(credentials),
    // A count only: the names can say too much about what the profile unlocks.
    describe: (credentials) => ({ account: secretCount(credentials) }),
  },
});
