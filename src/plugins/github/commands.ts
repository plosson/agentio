import { Command } from 'commander';
import { createProfileCommands } from '../../utils/profile-commands';
import { chooseProfileName, saveProfile } from '../../config/profile-store';
import { GitHubClient } from './client';
import { performGitHubOAuthFlow } from './oauth';
import { handleError } from '../../utils/errors';
import type { GitHubCredentials } from './types';

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

  profile
    .command('add')
    .description('Add a new GitHub profile')
    .option('--profile <name>', 'Profile name (auto-detected from username if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await githubProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function githubProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
  console.error('\nGitHub Setup\n');
  console.error('This will open your browser to authorize agentio with GitHub.');
  console.error('You will need to grant access to repositories where you want to set secrets.\n');

  // Perform OAuth flow
  const oauthResult = await performGitHubOAuthFlow();

  // Create client to fetch user info
  const credentials: GitHubCredentials = {
    accessToken: oauthResult.accessToken,
    username: '',
    email: null,
  };

  const client = new GitHubClient(credentials);
  const user = await client.getUser();

  // Update credentials with user info
  credentials.username = user.login;
  credentials.email = user.email;

  const profileName = await chooseProfileName('github', { explicit: options.profile, derived: user.login, readOnly: options.readOnly });

  console.error(`\nAuthenticated as: ${user.login}${user.email ? ` (${user.email})` : ''}`);

  await saveProfile('github', profileName, credentials, { readOnly: options.readOnly });

  console.log(`\nProfile "${profileName}" configured!`);
  if (options.readOnly) {
    console.log(`  Access: read-only`);
  }
  console.log(`  Install secrets: agentio github install owner/repo --profile ${profileName}`);
}
