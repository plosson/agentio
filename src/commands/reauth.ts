import { Command } from 'commander';
import { getProfileStatuses, type ProfileStatus } from './status';
import { getCredentials, setCredentials } from '../auth/token-store';
import { performGitHubOAuthFlow } from '../auth/github-oauth';
import { GitHubClient } from '../services/github/client';
import { interactiveCheckbox } from '../utils/interactive';
import { handleError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { GitHubCredentials } from '../types/github';
import { findServicePlugin } from '../plugins/registry';

// Services that require manual credential setup
const MANUAL_SERVICES: ServiceName[] = ['telegram', 'slack', 'discourse', 'dropbox', 'sql'];

async function reauthGitHub(profileName: string): Promise<void> {
  console.error(`\nRe-authenticating github / ${profileName}...`);

  const oauthResult = await performGitHubOAuthFlow();

  // Fetch updated user info
  const tempCreds: GitHubCredentials = {
    accessToken: oauthResult.accessToken,
    username: '',
    email: null,
  };
  const client = new GitHubClient(tempCreds);
  const user = await client.getUser();

  // Preserve existing fields, update token and user info
  const existing = await getCredentials<GitHubCredentials>('github', profileName);
  const credentials: GitHubCredentials = {
    ...existing,
    accessToken: oauthResult.accessToken,
    username: user.login,
    email: user.email,
  };

  await setCredentials('github', profileName, credentials);
  console.error(`  Done (${user.login})`);
}

export async function reauthProfile(service: ServiceName, profileName: string): Promise<void> {
  const pluginReauthenticate = findServicePlugin(service)?.profile?.reauthenticate;
  if (pluginReauthenticate) {
    const existing = await getCredentials<Record<string, unknown>>(service, profileName);
    const replacement = await pluginReauthenticate(existing, profileName);
    await setCredentials(service, profileName, replacement);
    return;
  }

  switch (service) {
    case 'github':
      await reauthGitHub(profileName);
      break;

    default:
      if (MANUAL_SERVICES.includes(service)) {
        console.error(`\nSkipping ${service} / ${profileName}: uses manual credentials. Run 'agentio ${service} profile add' to update.`);
      }
      break;
  }
}

export function registerReauthCommand(program: Command): void {
  program
    .command('reauth', { hidden: true })
    .description('Re-authenticate expired or invalid profiles')
    .option('--all', 'Re-authenticate all invalid profiles without prompting')
    .action(async (options) => {
      try {
        console.error('Checking profile credentials...\n');

        const statuses = await getProfileStatuses();
        const invalid = statuses.filter(
          (s) => s.status === 'invalid' || s.status === 'no-creds'
        );

        if (invalid.length === 0) {
          console.log('All profiles are valid.');
          return;
        }

        let selected: ProfileStatus[];

        if (options.all) {
          selected = invalid;
        } else {
          const choices = invalid.map((s) => ({
            name: `${s.service} / ${s.profile} (${s.error || 'no credentials'})`,
            value: s,
            checked: true,
          }));

          selected = await interactiveCheckbox({
            message: 'Select profiles to re-authenticate:',
            choices,
            required: true,
          });
        }

        for (const s of selected) {
          try {
            await reauthProfile(s.service, s.profile);
          } catch (error) {
            console.error(
              `\n  Failed to reauth ${s.service} / ${s.profile}: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        console.log('\nDone.');
      } catch (error) {
        handleError(error);
      }
    });
}
