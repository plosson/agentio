import { Command } from 'commander';
import { setCredentials, getCredentials } from '../auth/token-store';
import { setProfile, resolveProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { performJiraOAuthFlow, refreshJiraToken, type AtlassianSite } from '../auth/jira-oauth';
import { JiraClient } from '../services/jira/client';
import { CliError, handleError, multipleProfilesError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { interactiveSelect } from '../utils/interactive';
import { enforceWriteAccess } from '../utils/read-only';
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

      await setCredentials('jira', profile, newCredentials);
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
  const profileResult = await resolveProfile('jira', profileName);

  if (profileResult.profile === null) {
    if (profileResult.error === 'none') {
      if (profileName) {
        throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found for jira`, 'Run: agentio jira profile add');
      }
      throw new CliError('PROFILE_NOT_FOUND', 'No jira profile configured', 'Run: agentio jira profile add');
    }
    throw multipleProfilesError('jira', profileResult.names);
  }

  const profile = profileResult.profile;

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
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
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
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
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
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
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
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (issueKey: string, body: string | undefined, options) => {
      try {
        let text = body;

        if (!text) {
          text = await readStdin() || undefined;
        }

        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Comment body is required. Provide as argument or pipe via stdin.');
        }

        const { client, profile } = await getJiraClient(options.profile);
        await enforceWriteAccess('jira', profile, 'add comment');
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
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
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
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (issueKey: string, transitionId: string, options) => {
      try {
        const { client, profile } = await getJiraClient(options.profile);
        await enforceWriteAccess('jira', profile, 'transition issue');
        const result = await client.transitionIssue(issueKey, transitionId);
        printJiraTransitionResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<JiraCredentials>(jira, {
    service: 'jira',
    displayName: 'JIRA',
    getExtraInfo: (credentials) => credentials?.siteUrl ? ` - ${credentials.siteUrl}` : '',
  });

  profile
    .command('add')
    .description('Add a new JIRA profile with OAuth authentication')
    .option('--profile <name>', 'Profile name (auto-detected from site URL if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        console.error('\nJIRA OAuth Setup\n');

        // Site selection callback
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

        console.error(`\nAuthorized for site: ${result.siteUrl}\n`);

        // Auto-name based on site hostname
        const siteHostname = new URL(result.siteUrl).hostname;
        const profileName = options.profile || siteHostname;

        // Save credentials
        const credentials: JiraCredentials = {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiryDate: result.expiryDate,
          cloudId: result.cloudId,
          siteUrl: result.siteUrl,
        };

        await setProfile('jira', profileName, { readOnly: options.readOnly });
        await setCredentials('jira', profileName, credentials);

        console.log(`\nProfile "${profileName}" configured!`);
        if (options.readOnly) {
          console.log(`   Access: read-only`);
        }
        console.log(`   Test with: agentio jira projects --profile ${profileName}`);
      } catch (error) {
        handleError(error);
      }
    });
}
