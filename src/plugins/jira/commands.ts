import { Command } from 'commander';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup } from '../profile-host';
import { createClientGetter } from '../../utils/client-factory';
import { performJiraOAuthFlow } from './oauth';
import { JiraClient } from './client';
import { CliError, handleError } from '../../utils/errors';
import { readStdin } from '../../utils/stdin';
import { enforceWriteAccess } from '../../utils/read-only';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption } from '../../utils/output';
import {
  printJiraProjectList,
  printJiraIssueList,
  printJiraIssue,
  printJiraUsers,
  printJiraUser,
  printJiraTransitions,
  printJiraCommentResult,
  printJiraTransitionResult,
} from './output';
import type { JiraCredentials } from './types';
import type { SetupContext, SetupResult } from '../../plugin-sdk';

/** `--limit`: a positive whole number, or `all` for every match. */
export function parseLimit(input: string, option = '--limit'): number {
  const value = input.trim().toLowerCase();
  if (value === 'all') return Number.POSITIVE_INFINITY;
  if (/^\d+$/.test(value) && Number(value) > 0) return Number(value);
  throw new CliError('INVALID_PARAMS', `${option} must be a positive whole number or "all", not "${input}"`);
}

/** `--fields a,b c`: the extra Jira field ids to fetch. */
export function parseFields(input: string | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  const ids = input.split(/[\s,]+/).map((f) => f.trim()).filter(Boolean);
  if (ids.length === 0) throw new CliError('INVALID_PARAMS', '--fields needs at least one field id, e.g. --fields customfield_10016,duedate');
  return ids;
}

const FIELDS_HELP = 'Extra field ids to include, comma-separated (e.g. customfield_10016,duedate); raw values appear under extraFields';

const getJiraClient = createClientGetter<JiraCredentials, JiraClient>({
  service: 'jira',
  createClient: (credentials) => new JiraClient(credentials),
});

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
    addJsonOption(
      jira
        .command('search')
        .description('Search JIRA issues (pages through every match up to --limit)')
        .option('--profile <name>', 'Profile name (optional if only one profile exists)')
        .option('--jql <query>', 'JQL query')
        .option('--project <key>', 'Project key')
        .option('--status <status>', 'Issue status')
        .option('--assignee <name>', 'Assignee name')
        .option('--limit <number>', 'Maximum number of issues, or "all" (fetched page by page)', '50')
        .option('--page-token <token>', 'Continue a truncated search from the token it printed')
        .option('--fields <ids>', FIELDS_HELP),
    ).action(async (options) => {
      try {
        const maxResults = parseLimit(options.limit);
        const fields = parseFields(options.fields);
        const { client } = await getJiraClient(options.profile);
        const result = await client.searchIssues({
          jql: options.jql,
          project: options.project,
          status: options.status,
          assignee: options.assignee,
          maxResults,
          nextPageToken: options.pageToken,
          fields,
        });
        printJiraIssueList(result, options.json);
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

  # backfill: every match since July as JSON (accountIds, created, resolutionDate, parent...)
  agentio jira search --jql "updated >= 2026-07-01 ORDER BY key" --limit all --json > issues.json

  # add custom fields such as story points
  agentio jira search --project PROJ --fields customfield_10016 --json

Results are fetched page by page until --limit is reached. When more issues
match, stderr says so and prints a --page-token to continue from; --json output
carries "truncated" and "nextPageToken". Use a stable ORDER BY for long runs.

JQL syntax: project = KEY, assignee = currentUser(), status = "In Progress",
created >= -7d, updated >= -1d, priority = High, labels = bug, resolution = Unresolved.
Combine with AND / OR / NOT. Quote multi-word values.`,
  );

  // Get issue details
  addExamples(
    addJsonOption(
      jira
        .command('get')
        .description('Get JIRA issue details')
        .argument('<issue-key>', 'Issue key (e.g., PROJ-123)')
        .option('--profile <name>', 'Profile name (optional if only one profile exists)')
        .option('--comments', 'Include every comment')
        .option('--changelog', 'Include the full change history (status changes with dates, for time in status)')
        .option('--fields <ids>', FIELDS_HELP),
    ).action(async (issueKey: string, options) => {
      try {
        const fields = parseFields(options.fields);
        const { client } = await getJiraClient(options.profile);
        const issue = await client.getIssue(issueKey, {
          fields,
          comments: options.comments === true,
          changelog: options.changelog === true,
        });
        printJiraIssue(issue, options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # summary, status, parent/epic, labels, components, fix versions, dates, description
  agentio jira get PROJ-123

  # with comments and the full status history, as JSON
  agentio jira get PROJ-123 --comments --changelog --json

  # status changes only, for time in status
  agentio jira get PROJ-123 --changelog --json | jq '.changelog[] | {created, items: [.items[] | select(.fieldId == "status")]}'`,
  );

  // Users
  const users = jira
    .command('users')
    .description('Look up Jira users and their account ids');

  addExamples(
    addJsonOption(
      users
        .command('search')
        .description('Find users by name or email')
        .argument('<query>', 'Name, email or part of either')
        .option('--profile <name>', 'Profile name (optional if only one profile exists)')
        .option('--limit <number>', 'Maximum number of users (Jira looks at the first 1000 only)', '50'),
    ).action(async (query: string, options) => {
      try {
        if (!query.trim()) throw new CliError('INVALID_PARAMS', 'The search query cannot be empty');
        const limit = parseLimit(options.limit);
        const { client } = await getJiraClient(options.profile);
        const found = await client.searchUsers(query, { maxResults: limit });
        printJiraUsers(found, options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # map an email to an accountId
  agentio jira users search alice@example.com --json

  # everyone whose name starts with "ali"
  agentio jira users search ali

Email addresses appear only when the user's profile visibility allows it.
Jira needs the read:jira-user scope for user lookup. Without it the command
says so; assignee and reporter account ids are also in jira search --json.`,
  );

  addExamples(
    addJsonOption(
      users
        .command('get')
        .description('Get one user by account id')
        .argument('<account-id>', 'Atlassian account id')
        .option('--profile <name>', 'Profile name (optional if only one profile exists)'),
    ).action(async (accountId: string, options) => {
      try {
        const { client } = await getJiraClient(options.profile);
        printJiraUser(await client.getUser(accountId), options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio jira users get 5b10a2844c20165700ede21g --json`,
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
        await addProfileWithSetup('jira', jiraProfileAdd, options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function jiraProfileAdd(_options: { profile?: string; readOnly?: boolean }, context: SetupContext): Promise<SetupResult<JiraCredentials>> {
  context.log('\nJIRA OAuth Setup\n');

  const result = await performJiraOAuthFlow(context);

  context.log(`\nAuthorized for site: ${result.siteUrl}\n`);

  const siteHostname = new URL(result.siteUrl).hostname;
  const credentials: JiraCredentials = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiryDate: result.expiryDate,
    cloudId: result.cloudId,
    siteUrl: result.siteUrl,
  };

  return { credentials, suggestedProfileName: siteHostname, info: 'Test with: agentio jira projects' };
}
