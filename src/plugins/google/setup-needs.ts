import type { InputSpec, SetupNeeds } from '../../plugin-sdk';

// Kept apart from the command files, which reach the plugin registry through the vault: index.ts reads
// these while the plugins load, so they must not wait on a module that is still loading.

/** What a Google sign-in needs: only the browser. */
export const GOOGLE_SETUP_NEEDS: SetupNeeds = { inputs: [], auth: 'browser' };

export const GDRIVE_ACCESS_INPUT: InputSpec = {
  id: 'access', label: 'Access', kind: 'choice', default: 'readonly',
  choices: [
    { value: 'readonly', label: 'Read-only: list, search and download files' },
    { value: 'full', label: 'Full: also upload, create folders and change files' },
  ],
};

/** Google Drive asks how much access to take, then signs in with the browser. */
export const GDRIVE_SETUP_NEEDS: SetupNeeds = { inputs: [GDRIVE_ACCESS_INPUT], auth: 'browser' };
