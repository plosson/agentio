import { defineServicePlugin } from '../types';
import { GitHubClient } from './client';
import { githubProfileAdd, registerGitHubCommands } from './commands';
import { performGitHubOAuthFlow } from './oauth';
import type { GitHubCredentials } from './types';

async function reauthenticateGitHub(
  credentials: GitHubCredentials | null,
  profileName: string,
): Promise<GitHubCredentials> {
  console.error(`\nRe-authenticating github / ${profileName}...`);
  const oauth = await performGitHubOAuthFlow();
  const replacement = { ...credentials, accessToken: oauth.accessToken, username: '', email: null };
  const user = await new GitHubClient(replacement).getUser();
  console.error(`  Done (${user.login})`);
  return { ...replacement, username: user.login, email: user.email };
}

export default defineServicePlugin<GitHubCredentials>()({
  apiVersion: 1,
  id: 'github',
  displayName: 'GitHub',
  description: 'Use when interacting with GitHub via the agentio CLI.',
  registerCommands: registerGitHubCommands,
  profile: {
    setup: githubProfileAdd,
    createClient: (credentials) => new GitHubClient(credentials),
    reauthenticate: reauthenticateGitHub,
  },
});
