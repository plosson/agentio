import { Command } from 'commander';
import { getProfileStatuses, type ProfileStatus } from './status';
import { getCredentials, setCredentials } from '../auth/token-store';
import { performOAuthFlow, type OAuthService } from '../auth/oauth';
import { performGitHubOAuthFlow } from '../auth/github-oauth';
import { performJiraOAuthFlow, type AtlassianSite } from '../auth/jira-oauth';
import { fetchGoogleUserEmail } from '../auth/token-manager';
import { GitHubClient } from '../services/github/client';
import { interactiveCheckbox, interactiveSelect } from '../utils/interactive';
import { handleError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { GDocsCredentials } from '../types/gdocs';
import type { GDriveCredentials } from '../types/gdrive';
import type { GChatCredentials } from '../types/gchat';
import type { GSheetsCredentials } from '../types/gsheets';
import type { GitHubCredentials } from '../types/github';
import type { JiraCredentials } from '../types/jira';
import type { OAuthTokens } from '../types/tokens';

type GmailCredentials = OAuthTokens & { email?: string };
type GCalCredentials = OAuthTokens & { email?: string };
type GTasksCredentials = OAuthTokens & { email?: string };

// Services that use Google OAuth and store { ...tokens, email }
const GOOGLE_SIMPLE_SERVICES: ServiceName[] = ['gmail', 'gcal', 'gtasks'];

// Services that use Google OAuth with custom credential objects
const GOOGLE_CUSTOM_SERVICES: ServiceName[] = ['gdocs', 'gsheets'];

// Services that require manual credential setup
const MANUAL_SERVICES: ServiceName[] = ['telegram', 'slack', 'discourse', 'sql'];

async function reauthGoogleSimple(
  service: ServiceName,
  profileName: string
): Promise<void> {
  const oauthService = service as OAuthService;
  console.error(`\nRe-authenticating ${service} / ${profileName}...`);

  const tokens = await performOAuthFlow(oauthService);
  const email = await fetchGoogleUserEmail(tokens.access_token);

  // Preserve existing credential fields, update tokens and email
  const existing = await getCredentials<GmailCredentials | GCalCredentials | GTasksCredentials>(service, profileName);
  await setCredentials(service, profileName, { ...existing, ...tokens, email });

  console.error(`  Done (${email})`);
}

async function reauthGoogleCustom(
  service: ServiceName,
  profileName: string
): Promise<void> {
  const oauthService = service as OAuthService;
  console.error(`\nRe-authenticating ${service} / ${profileName}...`);

  const tokens = await performOAuthFlow(oauthService);
  const email = await fetchGoogleUserEmail(tokens.access_token);

  const existing = await getCredentials<GDocsCredentials | GSheetsCredentials>(service, profileName);
  const credentials = {
    ...existing,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email,
  };

  await setCredentials(service, profileName, credentials);
  console.error(`  Done (${email})`);
}

async function reauthGDrive(profileName: string): Promise<void> {
  console.error(`\nRe-authenticating gdrive / ${profileName}...`);

  // Read existing credentials to preserve accessLevel
  const existing = await getCredentials<GDriveCredentials>('gdrive', profileName);
  const accessLevel = existing?.accessLevel || 'readonly';
  const oauthService: OAuthService = accessLevel === 'full' ? 'gdrive-full' : 'gdrive-readonly';

  const tokens = await performOAuthFlow(oauthService);
  const email = await fetchGoogleUserEmail(tokens.access_token);

  const credentials: GDriveCredentials = {
    ...existing,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email,
    accessLevel,
  };

  await setCredentials('gdrive', profileName, credentials);
  console.error(`  Done (${email}, ${accessLevel})`);
}

async function reauthGChat(profileName: string): Promise<void> {
  const existing = await getCredentials<GChatCredentials>('gchat', profileName);

  if (existing?.type === 'webhook') {
    console.error(`\nSkipping gchat / ${profileName}: webhook profiles don't expire. Run 'agentio gchat profile add' to update.`);
    return;
  }

  console.error(`\nRe-authenticating gchat / ${profileName}...`);

  const tokens = await performOAuthFlow('gchat');
  const email = await fetchGoogleUserEmail(tokens.access_token);

  const credentials = {
    ...existing,
    type: 'oauth' as const,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email,
  };

  await setCredentials('gchat', profileName, credentials);
  console.error(`  Done (${email})`);
}

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

async function reauthJira(profileName: string): Promise<void> {
  console.error(`\nRe-authenticating jira / ${profileName}...`);

  const selectSite = async (sites: AtlassianSite[]): Promise<AtlassianSite> => {
    return interactiveSelect({
      message: 'Select a JIRA site:',
      choices: sites.map((site) => ({
        name: site.name,
        value: site,
        description: site.url,
      })),
    });
  };

  const result = await performJiraOAuthFlow(selectSite);

  const existing = await getCredentials<JiraCredentials>('jira', profileName);
  const credentials: JiraCredentials = {
    ...existing,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiryDate: result.expiryDate,
    cloudId: result.cloudId,
    siteUrl: result.siteUrl,
  };

  await setCredentials('jira', profileName, credentials);
  console.error(`  Done (${result.siteUrl})`);
}

export async function reauthProfile(service: ServiceName, profileName: string): Promise<void> {
  if (GOOGLE_SIMPLE_SERVICES.includes(service)) {
    await reauthGoogleSimple(service, profileName);
    return;
  }

  if (GOOGLE_CUSTOM_SERVICES.includes(service)) {
    await reauthGoogleCustom(service, profileName);
    return;
  }

  switch (service) {
    case 'gdrive':
      await reauthGDrive(profileName);
      break;

    case 'gchat':
      await reauthGChat(profileName);
      break;

    case 'github':
      await reauthGitHub(profileName);
      break;

    case 'jira':
      await reauthJira(profileName);
      break;

    case 'whatsapp':
      console.error(`\nSkipping whatsapp / ${profileName}: use 'agentio whatsapp profile add' to re-pair.`);
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
