import { writeJson } from '../../utils/output';
import type {
  JiraChangelogEntry,
  JiraCommentResult,
  JiraIssue,
  JiraProject,
  JiraSearchResult,
  JiraTransition,
  JiraTransitionResult,
  JiraUser,
} from './types';

/** `--json` writes `data` as one line of JSON; otherwise `text` prints for people and LLMs. */
function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data);
  else text();
}

/** "Alice Martin (5b10a2844c20165700ede21g)", the accountId being the stable part. */
export function formatUser(user: JiraUser | undefined): string | undefined {
  if (!user) return undefined;
  return `${user.displayName || '(no name)'} (${user.accountId})`;
}

/** What a truncated search tells the reader on stderr, so a cut-off list is never mistaken for all of it. */
export function truncationNotice(result: JiraSearchResult): string | undefined {
  if (!result.truncated) return undefined;
  const resume = result.nextPageToken ? ` or continue with --page-token ${result.nextPageToken}` : '';
  return `Note: more issues match than the ${result.issues.length} shown. Raise --limit (--limit all for every match)${resume}.`;
}

function extraFieldLines(issue: JiraIssue, indent: string): void {
  for (const [id, value] of Object.entries(issue.extraFields ?? {})) {
    console.log(`${indent}${id}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
}

export function printJiraProjectList(projects: JiraProject[]): void {
  if (projects.length === 0) {
    console.log('No projects found');
    return;
  }

  console.log(`Projects (${projects.length})\n`);

  for (const project of projects) {
    const privateMarker = project.isPrivate ? ' [private]' : '';
    console.log(`${project.key} - ${project.name}${privateMarker}`);
    console.log(`    Type: ${project.projectTypeKey}`);
    console.log('');
  }
}

export function printJiraIssueList(result: JiraSearchResult, json?: boolean): void {
  const notice = truncationNotice(result);
  emit(json, { count: result.issues.length, truncated: result.truncated, nextPageToken: result.nextPageToken ?? null, issues: result.issues }, () => {
    const { issues } = result;
    if (issues.length === 0) {
      console.log('No issues found');
      return;
    }

    console.log(`Issues (${issues.length}${result.truncated ? ', more match' : ''})\n`);

    for (const issue of issues) {
      console.log(`${issue.key} [${issue.status}] ${issue.summary}`);
      console.log(`    Type: ${issue.issueType} | Project: ${issue.projectKey}${issue.parent ? ` | Parent: ${issue.parent.key}` : ''}`);
      if (issue.assignee) console.log(`    Assignee: ${formatUser(issue.assignee)}`);
      if (issue.reporter) console.log(`    Reporter: ${formatUser(issue.reporter)}`);
      if (issue.priority) console.log(`    Priority: ${issue.priority}`);
      console.log(`    Created: ${issue.created} | Updated: ${issue.updated}`);
      if (issue.resolutionDate || issue.resolution) {
        console.log(`    Resolved: ${issue.resolutionDate ?? '-'}${issue.resolution ? ` (${issue.resolution})` : ''}`);
      }
      extraFieldLines(issue, '    ');
      console.log('');
    }
  });
  if (notice) console.error(notice);
}

export function printJiraIssue(issue: JiraIssue, json?: boolean): void {
  emit(json, issue, () => {
    console.log(`Key: ${issue.key}`);
    console.log(`Summary: ${issue.summary}`);
    console.log(`Status: ${issue.status}`);
    console.log(`Type: ${issue.issueType}`);
    console.log(`Project: ${issue.projectKey}`);
    if (issue.parent) {
      const about = [issue.parent.issueType, issue.parent.summary].filter(Boolean).join(': ');
      console.log(`Parent: ${issue.parent.key}${about ? ` (${about})` : ''}`);
    }
    if (issue.priority) console.log(`Priority: ${issue.priority}`);
    if (issue.assignee) console.log(`Assignee: ${formatUser(issue.assignee)}`);
    if (issue.reporter) console.log(`Reporter: ${formatUser(issue.reporter)}`);
    if (issue.labels.length > 0) console.log(`Labels: ${issue.labels.join(', ')}`);
    if (issue.components.length > 0) console.log(`Components: ${issue.components.join(', ')}`);
    if (issue.fixVersions.length > 0) console.log(`Fix versions: ${issue.fixVersions.join(', ')}`);
    console.log(`Created: ${issue.created}`);
    console.log(`Updated: ${issue.updated}`);
    if (issue.resolution) console.log(`Resolution: ${issue.resolution}`);
    if (issue.resolutionDate) console.log(`Resolved: ${issue.resolutionDate}`);
    extraFieldLines(issue, '');
    if (issue.description) {
      console.log('---');
      console.log(issue.description);
    }
    if (issue.comments) {
      console.log('---');
      console.log(`Comments (${issue.comments.length})`);
      for (const c of issue.comments) {
        console.log('');
        console.log(`${c.created} ${c.author}${c.authorAccountId ? ` (${c.authorAccountId})` : ''}:`);
        console.log(c.body);
      }
    }
    if (issue.changelog) {
      console.log('---');
      printChangelog(issue.changelog);
    }
  });
}

function printChangelog(entries: JiraChangelogEntry[]): void {
  console.log(`Changelog (${entries.length})`);
  for (const entry of entries) {
    const who = entry.author ? formatUser(entry.author) : 'unknown';
    for (const item of entry.items) {
      console.log(`${entry.created} ${who}: ${item.field}: ${item.fromString ?? item.from ?? '(none)'} → ${item.toString ?? item.to ?? '(none)'}`);
    }
  }
}

export function printJiraUsers(users: JiraUser[], json?: boolean): void {
  emit(json, { users }, () => {
    if (users.length === 0) {
      console.log('No users found');
      return;
    }
    console.log(`Users (${users.length})\n`);
    for (const user of users) printUserLines(user);
  });
}

export function printJiraUser(user: JiraUser, json?: boolean): void {
  emit(json, user, () => printUserLines(user));
}

function printUserLines(user: JiraUser): void {
  console.log(user.displayName || '(no name)');
  console.log(`    Account ID: ${user.accountId}`);
  if (user.emailAddress) console.log(`    Email: ${user.emailAddress}`);
  if (user.active !== undefined) console.log(`    Active: ${user.active ? 'yes' : 'no'}`);
  if (user.accountType) console.log(`    Account type: ${user.accountType}`);
  console.log('');
}

export function printJiraTransitions(issueKey: string, transitions: JiraTransition[]): void {
  if (transitions.length === 0) {
    console.log(`No transitions available for ${issueKey}`);
    return;
  }

  console.log(`Available transitions for ${issueKey}:\n`);

  for (const transition of transitions) {
    console.log(`[${transition.id}] ${transition.name} → ${transition.to.name}`);
  }
}

export function printJiraCommentResult(result: JiraCommentResult): void {
  console.log('Comment added');
  console.log(`Issue: ${result.issueKey}`);
  console.log(`Comment ID: ${result.id}`);
}

export function printJiraTransitionResult(result: JiraTransitionResult): void {
  console.log('Issue transitioned');
  console.log(`Issue: ${result.issueKey}`);
  console.log(`Transition: ${result.transitionName}`);
  console.log(`New Status: ${result.newStatus}`);
}
