import type { Command } from 'commander';
import { generateExportData } from './vault-config';
import { createClientGetter } from '../utils/client-factory';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import { CliError, handleError } from '../utils/errors';
import { GitHubClient } from '../plugins/github/client';
import type { GitHubCredentials } from '../plugins/github/types';

const getGitHubClient = createClientGetter<GitHubCredentials, GitHubClient>({
  service: 'github',
  createClient: (credentials) => new GitHubClient(credentials),
});

function assertRepo(repo: string): void {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid repository format: "${repo}"`,
      'Use the format: owner/repo (e.g., octocat/hello-world)',
    );
  }
}

/**
 * Agentio-owned GitHub commands that need privileged vault access. Keeping
 * these outside the service plugin prevents that plugin from reading the vault.
 */
export function registerGitHubVaultSecretCommands(program: Command): void {
  const github = program.commands.find((command) => command.name() === 'github');
  if (!github) return;

  addExamples(
    github
      .command('install')
      .description('Install AGENTIO_KEY and AGENTIO_CONFIG as GitHub Actions secrets')
      .argument('<repo>', 'Repository in owner/repo format')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (repo: string, options) => {
        try {
          assertRepo(repo);
          const { client, profile } = await getGitHubClient(options.profile);
          await enforceWriteAccess('github', profile, 'install secrets');
          console.error(`Using GitHub profile: ${profile}`);
          console.error(`Installing secrets to: ${repo}`);

          const exportData = await generateExportData();
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
      }),
    `Examples:

  # install secrets into a repo using the default github profile
  agentio github install octocat/hello-world

  # install secrets using a named profile
  agentio github install octocat/hello-world --profile work`,
  );

  addExamples(
    github
      .command('uninstall')
      .description('Remove AGENTIO_KEY and AGENTIO_CONFIG secrets from a repository')
      .argument('<repo>', 'Repository in owner/repo format')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (repo: string, options) => {
        try {
          assertRepo(repo);
          const { client, profile } = await getGitHubClient(options.profile);
          await enforceWriteAccess('github', profile, 'uninstall secrets');
          console.error(`Using GitHub profile: ${profile}`);
          console.error(`Removing secrets from: ${repo}`);

          console.error('\nDeleting AGENTIO_KEY...');
          await client.deleteRepoSecret(repo, 'AGENTIO_KEY');
          console.error('Deleting AGENTIO_CONFIG...');
          await client.deleteRepoSecret(repo, 'AGENTIO_CONFIG');
          console.log(`\nRemoved AGENTIO_KEY and AGENTIO_CONFIG from ${repo}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # remove the agentio secrets from a repo
  agentio github uninstall octocat/hello-world

  # uninstall using a named profile
  agentio github uninstall octocat/hello-world --profile work`,
  );
}
