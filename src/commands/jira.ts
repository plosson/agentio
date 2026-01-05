import { Command } from 'commander';
import { setCredentials, removeCredentials, getCredentials, setCredentials as updateCredentials } from '../auth/token-store';
import { setProfile, removeProfile, listProfiles, getProfile } from '../config/config-manager';
import { performJiraOAuthFlow, refreshJiraToken, type AtlassianSite } from '../auth/jira-oauth';
import { JiraClient } from '../services/jira/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt, resolveProfileName } from '../utils/stdin';
import {
  printJiraProjectList,
  printJiraIssueList,
  printJiraIssue,
  printJiraTransitions,
  printJiraCommentResult,
  printJiraTransitionResult,
} from '../utils/output';
import type { JiraCredentials } from '../types/jira';

async function ensureValidToken(credentials: JiraCredentials, profile: string): Promise<JiraCredentials> {
  // Check if token is expired or about to expire (within 5 minutes)
  const bufferTime = 5 * 60 * 1000;
  if (credentials.expiryDate && Date.now() + bufferTime >= credentials.expiryDate) {
    console.error('Access token expired, refreshing...');

    try {
      const refreshed = await refreshJiraToken(credentials.refreshToken);

      const newCredentials: JiraCredentials = {
        ...credentials,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiryDate: Date.now() + refreshed.expiresIn * 1000,
      };

      await updateCredentials('jira', profile, newCredentials);
      return newCredentials;
    } catch (error) {
      throw new CliError(
        'AUTH_FAILED',
        'Failed to refresh access token. Please re-authenticate.',
        `Run: agentio jira profile add --profile ${profile}`
      );
    }
  }

  return credentials;
}

async function getJiraClient(profileName?: string): Promise<{ client: JiraClient; profile: string }> {
  const profile = await getProfile('jira', profileName);

  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      profileName
        ? `Profile "${profileName}" not found for jira`
        : 'No default profile configured for jira',
      'Run: agentio jira profile add'
    );
  }

  let credentials = await getCredentials<JiraCredentials>('jira', profile);

  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for jira profile "${profile}"`,
      `Run: agentio jira profile add --profile ${profile}`
    );
  }

  // Ensure token is valid
  credentials = await ensureValidToken(credentials, profile);

  return {
    client: new JiraClient(credentials),
    profile,
  };
}

export function registerJiraCommands(program: Command): void {
  const jira = program
    .command('jira')
    .description('JIRA operations');

  // List projects
  jira
    .command('projects')
    .description('List JIRA projects')
    .option('--profile <name>', 'Profile name')
    .option('--limit <number>', 'Maximum number of projects', '50')
    .action(async (options) => {
      try {
        const { client } = await getJiraClient(options.profile);
        const projects = await client.listProjects({
          maxResults: parseInt(options.limit, 10),
        });
        printJiraProjectList(projects);
      } catch (error) {
        handleError(error);
      }
    });

  // Search issues
  jira
    .command('search')
    .description('Search JIRA issues')
    .option('--profile <name>', 'Profile name')
    .option('--jql <query>', 'JQL query')
    .option('--project <key>', 'Project key')
    .option('--status <status>', 'Issue status')
    .option('--assignee <name>', 'Assignee name')
    .option('--limit <number>', 'Maximum number of issues', '50')
    .action(async (options) => {
      try {
        const { client } = await getJiraClient(options.profile);
        const issues = await client.searchIssues({
          jql: options.jql,
          project: options.project,
          status: options.status,
          assignee: options.assignee,
          maxResults: parseInt(options.limit, 10),
        });
        printJiraIssueList(issues);
      } catch (error) {
        handleError(error);
      }
    });

  // Get issue details
  jira
    .command('get')
    .description('Get JIRA issue details')
    .argument('<issue-key>', 'Issue key (e.g., PROJ-123)')
    .option('--profile <name>', 'Profile name')
    .action(async (issueKey: string, options) => {
      try {
        const { client } = await getJiraClient(options.profile);
        const issue = await client.getIssue(issueKey);
        printJiraIssue(issue);
      } catch (error) {
        handleError(error);
      }
    });

  // Add comment
  jira
    .command('comment')
    .description('Add a comment to an issue')
    .argument('<issue-key>', 'Issue key (e.g., PROJ-123)')
    .argument('[body]', 'Comment body (or pipe via stdin)')
    .option('--profile <name>', 'Profile name')
    .action(async (issueKey: string, body: string | undefined, options) => {
      try {
        let text = body;

        if (!text) {
          text = await readStdin() || undefined;
        }

        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Comment body is required. Provide as argument or pipe via stdin.');
        }

        const { client } = await getJiraClient(options.profile);
        const result = await client.addComment(issueKey, text);
        printJiraCommentResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  // List transitions
  jira
    .command('transitions')
    .description('List available transitions for an issue')
    .argument('<issue-key>', 'Issue key (e.g., PROJ-123)')
    .option('--profile <name>', 'Profile name')
    .action(async (issueKey: string, options) => {
      try {
        const { client } = await getJiraClient(options.profile);
        const transitions = await client.getTransitions(issueKey);
        printJiraTransitions(issueKey, transitions);
      } catch (error) {
        handleError(error);
      }
    });

  // Transition issue (change status)
  jira
    .command('transition')
    .description('Transition an issue to a new status')
    .argument('<issue-key>', 'Issue key (e.g., PROJ-123)')
    .argument('<transition-id>', 'Transition ID (use "transitions" command to see available)')
    .option('--profile <name>', 'Profile name')
    .action(async (issueKey: string, transitionId: string, options) => {
      try {
        const { client } = await getJiraClient(options.profile);
        const result = await client.transitionIssue(issueKey, transitionId);
        printJiraTransitionResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = jira
    .command('profile')
    .description('Manage JIRA profiles');

  profile
    .command('add')
    .description('Add a new JIRA profile with OAuth authentication')
    .option('--profile <name>', 'Profile name', 'default')
    .action(async (options) => {
      try {
        const profileName = await resolveProfileName('jira', options.profile);

        console.error('\n🔧 JIRA OAuth Setup\n');

        // Site selection callback
        const selectSite = async (sites: AtlassianSite[]): Promise<AtlassianSite> => {
          console.error('\nMultiple JIRA sites found:\n');
          sites.forEach((site, index) => {
            console.error(`  [${index + 1}] ${site.name} (${site.url})`);
          });
          console.error('');

          const choice = await prompt(`? Select a site (1-${sites.length}): `);
          const index = parseInt(choice, 10) - 1;

          if (isNaN(index) || index < 0 || index >= sites.length) {
            throw new CliError('INVALID_PARAMS', 'Invalid selection');
          }

          return sites[index];
        };

        const result = await performJiraOAuthFlow(selectSite);

        console.error(`\n✓ Authorized for site: ${result.siteUrl}\n`);

        // Save credentials
        const credentials: JiraCredentials = {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiryDate: result.expiryDate,
          cloudId: result.cloudId,
          siteUrl: result.siteUrl,
        };

        await setProfile('jira', profileName);
        await setCredentials('jira', profileName, credentials);

        console.log(`\n✅ Profile "${profileName}" configured!`);
        console.log(`   Test with: agentio jira projects --profile ${profileName}`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('List JIRA profiles')
    .action(async () => {
      try {
        const result = await listProfiles('jira');
        const { profiles, default: defaultProfile } = result[0];

        if (profiles.length === 0) {
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials<JiraCredentials>('jira', name);
            const siteInfo = credentials?.siteUrl ? ` - ${credentials.siteUrl}` : '';
            console.log(`${name}${marker}${siteInfo}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove a JIRA profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        const removed = await removeProfile('jira', profileName);
        await removeCredentials('jira', profileName);

        if (removed) {
          console.error(`Removed profile "${profileName}"`);
        } else {
          console.error(`Profile "${profileName}" not found`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
