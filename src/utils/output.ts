import type { GmailMessage, GmailAttachmentInfo } from '../types/gmail';
import type { GChatMessage } from '../types/gchat';
import type { JiraProject, JiraIssue, JiraTransition, JiraCommentResult, JiraTransitionResult } from '../types/jira';
import type { SlackSendResult } from '../types/slack';
import type { RssFeed, RssArticle } from '../types/rss';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Format a list of Gmail messages
export function printMessageList(messages: GmailMessage[], total: number): void {
  console.log(`Messages (${messages.length} of ~${total})\n`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`[${i + 1}] ${msg.id} | thread:${msg.threadId}`);
    console.log(`    From: ${msg.from}`);
    if (msg.to.length) console.log(`    To: ${msg.to.join(', ')}`);
    console.log(`    Date: ${msg.date}`);
    console.log(`    Subject: ${msg.subject}`);
    if (msg.labels.length) console.log(`    Labels: ${msg.labels.join(', ')}`);
    if (msg.snippet) console.log(`    > ${msg.snippet}`);
    console.log('');
  }
}

// Format a single Gmail message with body
export function printMessage(msg: GmailMessage & { body: string }): void {
  console.log(`ID: ${msg.id}`);
  console.log(`Thread: ${msg.threadId}`);
  console.log(`From: ${msg.from}`);
  if (msg.to.length) console.log(`To: ${msg.to.join(', ')}`);
  if (msg.cc.length) console.log(`CC: ${msg.cc.join(', ')}`);
  console.log(`Date: ${msg.date}`);
  console.log(`Subject: ${msg.subject}`);
  if (msg.labels.length) console.log(`Labels: ${msg.labels.join(', ')}`);
  if (msg.attachments && msg.attachments.length > 0) {
    console.log(`Attachments: ${msg.attachments.length}`);
    for (const att of msg.attachments) {
      console.log(`  - ${att.filename} (${formatBytes(att.size)}) [${att.id}]`);
    }
  }
  console.log('---');
  console.log(msg.body);
}

// Format attachment list
export function printAttachmentList(attachments: GmailAttachmentInfo[]): void {
  if (attachments.length === 0) {
    console.log('No attachments');
    return;
  }

  console.log(`Attachments (${attachments.length})\n`);
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    console.log(`[${i + 1}] ${att.filename}`);
    console.log(`    Size: ${formatBytes(att.size)}`);
    console.log(`    Type: ${att.mimeType}`);
    console.log(`    ID: ${att.id}`);
    console.log('');
  }
}

// Format attachment download result
export function printAttachmentDownloaded(filename: string, path: string, size: number): void {
  console.log(`Downloaded: ${filename}`);
  console.log(`  Path: ${path}`);
  console.log(`  Size: ${formatBytes(size)}`);
}

// Format send/reply result
export function printSendResult(result: { id: string; threadId: string }): void {
  console.log('Message sent');
  console.log(`ID: ${result.id}`);
  console.log(`Thread: ${result.threadId}`);
}

// Format archive confirmation
export function printArchived(messageId: string): void {
  console.log(`Archived: ${messageId}`);
}

// Format mark read/unread confirmation
export function printMarked(messageId: string, read: boolean): void {
  console.log(`Marked ${messageId} as ${read ? 'read' : 'unread'}`);
}

// Output raw text (for body-only mode)
export function raw(text: string): void {
  console.log(text);
}

// Google Chat specific formatters
export function printGChatSendResult(result: { messageId: string; spaceId?: string; isJsonPayload?: boolean }): void {
  console.log('Message sent');
  console.log(`ID: ${result.messageId}`);
  if (result.spaceId) {
    console.log(`Space: ${result.spaceId}`);
  }
  if (result.isJsonPayload) {
    console.log('Type: JSON payload');
  }
}

export function printGChatMessageList(messages: GChatMessage[]): void {
  if (messages.length === 0) {
    console.log('No messages found');
    return;
  }

  console.log(`Messages (${messages.length})\n`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`[${i + 1}] ${msg.name}`);
    if (msg.sender) {
      console.log(`    From: ${msg.sender.displayName || 'Unknown'}`);
    }
    if (msg.text) {
      const snippet = msg.text.length > 100 ? msg.text.substring(0, 100) + '...' : msg.text;
      console.log(`    > ${snippet}`);
    }
    console.log(`    Date: ${msg.createTime}`);
    console.log('');
  }
}

export function printGChatMessage(msg: GChatMessage): void {
  console.log(`ID: ${msg.name}`);
  if (msg.sender) {
    console.log(`From: ${msg.sender.displayName || 'Unknown'}`);
  }
  console.log(`Date: ${msg.createTime}`);
  if (msg.thread) {
    console.log(`Thread: ${msg.thread.name}`);
  }
  if (msg.text) {
    console.log('---');
    console.log(msg.text);
  }
}

// JIRA specific formatters
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

// Slack specific formatters
export function printSlackSendResult(result: SlackSendResult): void {
  console.log('Message sent');
  if (result.isJsonPayload) {
    console.log('Type: Block Kit payload');
  }
}

// RSS specific formatters
export function printRssArticleList(articles: RssArticle[], feedName: string): void {
  if (articles.length === 0) {
    console.log('No articles found');
    return;
  }

  console.log(`Articles from ${feedName} (${articles.length})\n`);

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    console.log(`[${i + 1}] ${article.title}`);
    if (article.author) console.log(`    Author: ${article.author}`);
    if (article.pubDate) console.log(`    Date: ${article.pubDate}`);
    if (article.link) console.log(`    Link: ${article.link}`);
    if (article.description) {
      const snippet = article.description.length > 150
        ? article.description.substring(0, 150) + '...'
        : article.description;
      console.log(`    > ${snippet}`);
    }
    console.log('');
  }
}

export function printRssArticle(article: RssArticle): void {
  console.log(`Title: ${article.title}`);
  if (article.author) console.log(`Author: ${article.author}`);
  if (article.pubDate) console.log(`Date: ${article.pubDate}`);
  if (article.link) console.log(`Link: ${article.link}`);
  if (article.categories && article.categories.length > 0) {
    console.log(`Categories: ${article.categories.join(', ')}`);
  }
  console.log('---');
  console.log(article.content || article.description || 'No content available');
}

export function printRssFeedInfo(feed: RssFeed & { feedUrl: string }): void {
  console.log(`Title: ${feed.title}`);
  console.log(`Feed URL: ${feed.feedUrl}`);
  if (feed.description) console.log(`Description: ${feed.description}`);
  if (feed.link) console.log(`Site: ${feed.link}`);
  if (feed.language) console.log(`Language: ${feed.language}`);
  if (feed.lastBuildDate) console.log(`Last Updated: ${feed.lastBuildDate}`);
  console.log(`Articles: ${feed.items.length}`);
}
