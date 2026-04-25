import { Command } from 'commander';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { GitHubClient } from '../services/github/client';
import { performGitHubOAuthFlow } from '../auth/github-oauth';
import { generateExportData } from './config';
import { CliError, handleError } from '../utils/errors';
import { enforceWriteAccess } from '../utils/read-only';
import type { GitHubCredentials } from '../types/github';

const getGitHubClient = createClientGetter<GitHubCredentials, GitHubClient>({
  service: 'github',
  createClient: (credentials) => new GitHubClient(credentials),
});

function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid repository format: "${repo}"`,
      'Use the format: owner/repo (e.g., octocat/hello-world)'
    );
  }
  return { owner: parts[0], name: parts[1] };
}

export function registerGitHubCommands(program: Command): void {
  const github = program
    .command('github')
    .description('GitHub operations');

  github
    .command('install')
    .description('Install AGENTIO_KEY and AGENTIO_CONFIG as GitHub Actions secrets')
    .argument('<repo>', 'Repository in owner/repo format')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (repo: string, options) => {
      try {
        // Validate repo format
        parseRepo(repo);

        const { client, profile } = await getGitHubClient(options.profile);
        await enforceWriteAccess('github', profile, 'install secrets');

        console.error(`Using GitHub profile: ${profile}`);
        console.error(`Installing secrets to: ${repo}`);

        // Generate the export data
        const exportData = await generateExportData();

        // Set secrets on the repo
        console.error('\nSetting AGENTIO_KEY...');
        await client.setRepoSecret(repo, 'AGENTIO_KEY', exportData.key);

        console.error('Setting AGENTIO_CONFIG...');
        await client.setRepoSecret(repo, 'AGENTIO_CONFIG', exportData.config);

        console.log(`\nInstalled AGENTIO_KEY and AGENTIO_CONFIG to ${repo}`);
        console.log('\nIn your GitHub Actions workflow, use:');
        console.log('  env:');
        console.log('    AGENTIO_KEY: ${{ secrets.AGENTIO_KEY }}');
        console.log('    AGENTIO_CONFIG: ${{ secrets.AGENTIO_CONFIG }}');
      } catch (error) {
        handleError(error);
      }
    });

  github
    .command('uninstall')
    .description('Remove AGENTIO_KEY and AGENTIO_CONFIG secrets from a repository')
    .argument('<repo>', 'Repository in owner/repo format')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (repo: string, options) => {
      try {
        // Validate repo format
        parseRepo(repo);

        const { client, profile } = await getGitHubClient(options.profile);
        await enforceWriteAccess('github', profile, 'uninstall secrets');

        console.error(`Using GitHub profile: ${profile}`);
        console.error(`Removing secrets from: ${repo}`);

        // Delete secrets from the repo
        console.error('\nDeleting AGENTIO_KEY...');
        await client.deleteRepoSecret(repo, 'AGENTIO_KEY');

        console.error('Deleting AGENTIO_CONFIG...');
        await client.deleteRepoSecret(repo, 'AGENTIO_CONFIG');

        console.log(`\nRemoved AGENTIO_KEY and AGENTIO_CONFIG from ${repo}`);
      } catch (error) {
        handleError(error);
      }
    });

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

  const profileName = options.profile || user.login;

  console.error(`\nAuthenticated as: ${user.login}${user.email ? ` (${user.email})` : ''}`);

  // Save credentials
  await setProfile('github', profileName, { readOnly: options.readOnly });
  await setCredentials('github', profileName, credentials);

  console.log(`\nProfile "${profileName}" configured!`);
  if (options.readOnly) {
    console.log(`  Access: read-only`);
  }
  console.log(`  Install secrets: agentio github install owner/repo --profile ${profileName}`);
}
