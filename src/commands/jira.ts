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
import { addExamples } from '../utils/command-tree';
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
  addExamples(
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
      }),
    `Examples:

  # all visible projects (default limit 50)
  agentio jira projects

  # cap the result count
  agentio jira projects --limit 10`,
  );

  // Search issues
  addExamples(
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
      }),
    `Examples:

  # everything assigned to you across all projects
  agentio jira search --jql "assignee = currentUser() AND resolution = Unresolved"

  # bugs created in the last week in one project
  agentio jira search --jql "project = PROJ AND issuetype = Bug AND created >= -7d"

  # convenience flags (combined with AND)
  agentio jira search --project PROJ --status "In Progress" --assignee alice

  # high-priority items updated today, capped to 10
  agentio jira search --jql "priority = High AND updated >= -1d" --limit 10

JQL syntax: project = KEY, assignee = currentUser(), status = "In Progress",
created >= -7d, updated >= -1d, priority = High, labels = bug, resolution = Unresolved.
Combine with AND / OR / NOT. Quote multi-word values.`,
  );

  // Get issue details
  addExamples(
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
      }),
    `Examples:

  # full issue (summary, status, description, comments)
  agentio jira get PROJ-123`,
  );

  // Add comment
  addExamples(
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
      }),
    `Examples:

  # short comment as an argument
  agentio jira comment PROJ-123 "Reproduced on staging."

  # multi-line comment via stdin
  cat investigation.md | agentio jira comment PROJ-123`,
  );

  // List transitions
  addExamples(
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
      }),
    `Examples:

  # see transition ids before calling 'jira transition'
  agentio jira transitions PROJ-123`,
  );

  // Transition issue (change status)
  addExamples(
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
      }),
    `Examples:

  # move PROJ-123 to the status whose transition id is 31
  agentio jira transition PROJ-123 31

  # discover the id first, then run the transition
  agentio jira transitions PROJ-123
  agentio jira transition PROJ-123 41`,
  );

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
        await jiraProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function jiraProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
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
}
