import type {
  JiraCommentResult,
  JiraIssue,
  JiraProject,
  JiraTransition,
  JiraTransitionResult,
} from './types';

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

export function printJiraIssueList(issues: JiraIssue[]): void {
  if (issues.length === 0) {
    console.log('No issues found');
    return;
  }

  console.log(`Issues (${issues.length})\n`);

  for (const issue of issues) {
    console.log(`${issue.key} [${issue.status}] ${issue.summary}`);
    console.log(`    Type: ${issue.issueType} | Project: ${issue.projectKey}`);
    if (issue.assignee) console.log(`    Assignee: ${issue.assignee}`);
    if (issue.priority) console.log(`    Priority: ${issue.priority}`);
    console.log(`    Updated: ${issue.updated}`);
    console.log('');
  }
}

export function printJiraIssue(issue: JiraIssue): void {
  console.log(`Key: ${issue.key}`);
  console.log(`Summary: ${issue.summary}`);
  console.log(`Status: ${issue.status}`);
  console.log(`Type: ${issue.issueType}`);
  console.log(`Project: ${issue.projectKey}`);
  if (issue.priority) console.log(`Priority: ${issue.priority}`);
  if (issue.assignee) console.log(`Assignee: ${issue.assignee}`);
  if (issue.reporter) console.log(`Reporter: ${issue.reporter}`);
  console.log(`Created: ${issue.created}`);
  console.log(`Updated: ${issue.updated}`);
  if (issue.description) {
    console.log('---');
    console.log(issue.description);
  }
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
