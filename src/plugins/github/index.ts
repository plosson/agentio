import { defineServicePlugin } from '../types';
import type { SetupContext } from '../../plugin-sdk';
import { GitHubClient } from './client';
import { githubProfileAdd, registerGitHubCommands, signInToGitHub } from './commands';
import { GITHUB_SETUP_NEEDS } from './setup-needs';
import type { GitHubCredentials } from './types';

async function reauthenticateGitHub(
  _credentials: GitHubCredentials | null,
  profileName: string,
  context: SetupContext,
): Promise<GitHubCredentials> {
  context.log(`\nRe-authenticating github / ${profileName}...`);
  const { credentials, login } = await signInToGitHub(context);
  context.log(`  Done (${login})`);
  return credentials;
}

export default defineServicePlugin<GitHubCredentials>()({
  apiVersion: 1,
  id: 'github',
  displayName: 'GitHub',
  description: 'Use when interacting with GitHub via the agentio CLI.',
  brand: { url: 'https://github.com' },
  registerCommands: registerGitHubCommands,
  profile: {
    needs: GITHUB_SETUP_NEEDS,
    setup: githubProfileAdd,
    createClient: (credentials) => new GitHubClient(credentials),
    describe: (credentials) => ({ account: credentials.username, url: credentials.username ? `https://github.com/${encodeURIComponent(credentials.username)}` : undefined }),
    reauthenticate: reauthenticateGitHub,
  },
});
