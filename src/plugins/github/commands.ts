import { Command } from 'commander';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import { GitHubClient } from './client';
import { performGitHubOAuthFlow } from './oauth';
import { handleError } from '../../utils/errors';
import type { GitHubCredentials } from './types';
import type { SetupContext, SetupResult } from '../../plugin-sdk';

export function registerGitHubCommands(program: Command): void {
  const github = program
    .command('github')
    .description('GitHub operations');

  // Profile management
  const profile = createProfileCommands<GitHubCredentials>(github, {
    service: 'github',
    displayName: 'GitHub',
    getExtraInfo: (credentials) => credentials?.username ? ` (${credentials.username})` : '',
  });

  addSetupOptions(
    profile
      .command('add')
      .description('Add a new GitHub profile')
      .option('--profile <name>', 'Profile name (auto-detected from username if not provided)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
  )
    .action(async (options) => {
      try {
        await addProfileWithSetup('github', githubProfileAdd, options);
      } catch (error) {
        handleError(error);
      }
    });
}

/** The browser sign-in, then who signed in: the steps setup and sign-in-again share. */
export async function signInToGitHub(context: SetupContext): Promise<{ credentials: GitHubCredentials; login: string }> {
  const oauthResult = await performGitHubOAuthFlow(context);

  // Create client to fetch user info
  const credentials: GitHubCredentials = {
    accessToken: oauthResult.accessToken,
    username: '',
    email: null,
  };

  const user = await new GitHubClient(credentials).getUser();

  // Update credentials with user info
  credentials.username = user.login;
  credentials.email = user.email;
  return { credentials, login: user.login };
}

export async function githubProfileAdd(
  _options: { profile?: string; readOnly?: boolean },
  context: SetupContext,
): Promise<SetupResult<GitHubCredentials>> {
  context.log('\nGitHub Setup\n');
  context.log('This will open your browser to authorize agentio with GitHub.');
  context.log('You will need to grant access to repositories where you want to set secrets.\n');

  const { credentials, login } = await signInToGitHub(context);

  context.log(`\nAuthenticated as: ${login}${credentials.email ? ` (${credentials.email})` : ''}`);
  return { credentials, suggestedProfileName: login, info: 'Install secrets: agentio github install owner/repo' };
}
