import { homedir } from 'os';
import type { GmailMessage, GmailAttachmentInfo, GmailLabel, GmailFilter, GmailFilterCriteria, GmailFilterAction } from '../types/gmail';
import type { GChatMessage, GChatSpace, GChatMember, GChatUser } from '../types/gchat';
import type { GDocsDocument, GDocsCreateResult, GDocsBatchResult } from '../types/gdocs';
import type { GDriveFile, GDriveDownloadResult, GDriveUploadResult, GDrivePermission, GDriveShareResult, GDriveCopyResult } from '../types/gdrive';
import type { GCalCalendar, GCalEvent, GCalFreeBusyResponse } from '../types/gcal';
import type { GTaskList, GTask } from '../types/gtasks';
import type { JiraProject, JiraIssue, JiraTransition, JiraCommentResult, JiraTransitionResult } from '../types/jira';
import type {
  ConfluenceSpace,
  ConfluencePage,
  ConfluencePageDetail,
  ConfluenceComment,
  ConfluenceSearchResult,
  ConfluencePageCreateResult,
  ConfluencePageUpdateResult,
  ConfluenceCommentResult,
} from '../types/confluence';
import type { SlackSendResult } from '../types/slack';
import type { RssFeed, RssArticle } from '../types/rss';
import type { DiscourseCategory, DiscourseTopic, DiscourseTopicDetail } from '../types/discourse';
import type {
  GSlidesListItem,
  GSlidesPresentation,
  GSlidesSlideContent,
  GSlidesCreateResult,
  GSlidesBatchResult,
} from '../types/gslides';
import type {
  GScriptProject,
  GScriptListItem,
  GScriptFile,
  GScriptPullResult,
  GScriptPushResult,
} from '../types/gscript';

/** Replace $HOME prefix with `~` for display. */
export function abbrHome(p: string, home: string = homedir()): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

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
    if (msg.from) console.log(`    From: ${msg.from}`);
    if (msg.to.length) console.log(`    To: ${msg.to.join(', ')}`);
    if (msg.date) console.log(`    Date: ${msg.date}`);
    if (msg.subject) console.log(`    Subject: ${msg.subject}`);
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

// Format draft creation result
export function printDraftResult(result: { id: string; messageId: string }, updated = false): void {
  console.log(updated ? 'Draft updated' : 'Draft created');
  console.log(`Draft ID: ${result.id}`);
  console.log(`Message ID: ${result.messageId}`);
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

// Format Gmail label list
export function printLabelList(labels: GmailLabel[]): void {
  if (labels.length === 0) {
    console.log('No labels found');
    return;
  }
  const nameWidth = Math.max(4, ...labels.map((l) => l.name.length));
  const typeWidth = 6;
  console.log(`${'NAME'.padEnd(nameWidth)}  ${'TYPE'.padEnd(typeWidth)}  ID`);
  for (const label of labels) {
    console.log(`${label.name.padEnd(nameWidth)}  ${label.type.padEnd(typeWidth)}  ${label.id}`);
  }
  console.log(`\n${labels.length} label(s)`);
}

export function printLabelCreated(label: GmailLabel): void {
  console.log(`Created label: ${label.name}`);
  console.log(`ID: ${label.id}`);
}

export function printLabelDeleted(name: string, id: string): void {
  console.log(`Deleted label: ${name} (${id})`);
}

export function printLabelRenamed(oldName: string, label: GmailLabel): void {
  console.log(`Renamed label: ${oldName} -> ${label.name}`);
  console.log(`ID: ${label.id}`);
}

export function printLabelModified(
  id: string,
  isThread: boolean,
  applied: string[],
  removed: string[],
): void {
  const target = isThread ? 'thread' : 'message';
  const parts: string[] = [];
  if (applied.length) parts.push(`applied [${applied.join(', ')}]`);
  if (removed.length) parts.push(`removed [${removed.join(', ')}]`);
  console.log(`${target} ${id}: ${parts.join('; ')}`);
}

export function printBatchProgress(action: string, p: {
  chunkIndex: number;
  totalChunks: number;
  ids: number;
  durationMs: number;
  status: 'ok' | 'failed';
  error?: string;
}): void {
  const tag = `[${action}] chunk ${p.chunkIndex}/${p.totalChunks} (${p.ids} ids)`;
  if (p.status === 'ok') {
    console.error(`${tag} ok in ${p.durationMs}ms`);
  } else {
    console.error(`${tag} FAILED in ${p.durationMs}ms: ${p.error ?? 'unknown'}`);
  }
}

export function printBatchSummary(
  action: string,
  result: { totalIds: number; ok: number; failed: { ids: string[]; reason: string }[]; chunks: number },
): void {
  console.log(`${action}: ${result.ok}/${result.totalIds} succeeded across ${result.chunks} chunk(s)`);
  if (result.failed.length) {
    console.log(`Failed chunks: ${result.failed.length}`);
    for (const f of result.failed) {
      const range = f.ids.length > 4
        ? `${f.ids[0]}..${f.ids[f.ids.length - 1]} (${f.ids.length} ids)`
        : f.ids.join(', ');
      console.log(`  - ${range}: ${f.reason}`);
    }
  }
}

export function printBatchDryRun(
  action: string,
  plan: { totalIds: number; chunkSize: number; chunks: number; addLabels: string[]; removeLabels: string[] },
): void {
  console.log(`[dry-run] ${action}`);
  console.log(`  ids: ${plan.totalIds}`);
  console.log(`  chunk size: ${plan.chunkSize}`);
  console.log(`  chunks: ${plan.chunks}`);
  if (plan.addLabels.length) console.log(`  add labels: ${plan.addLabels.join(', ')}`);
  if (plan.removeLabels.length) console.log(`  remove labels: ${plan.removeLabels.join(', ')}`);
  console.log(`  no API calls made`);
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
      const from = msg.sender.email
        ? `${msg.sender.displayName} <${msg.sender.email}>`
        : msg.sender.displayName || 'Unknown';
      console.log(`    From: ${from}`);
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
    const from = msg.sender.email
      ? `${msg.sender.displayName} <${msg.sender.email}>`
      : msg.sender.displayName || 'Unknown';
    console.log(`From: ${from}`);
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

export function printGChatSpaceList(spaces: GChatSpace[]): void {
  if (spaces.length === 0) {
    console.log('No spaces found');
    return;
  }

  console.log(`Spaces (${spaces.length})\n`);

  for (const space of spaces) {
    const spaceId = space.name.replace('spaces/', '');
    const name = space.displayName || 'Unnamed';
    const desc = space.description ? `  - ${space.description}` : '';
    console.log(`[${space.type}] ${spaceId}  ${name}${desc}`);
  }
}

export function printGChatMemberList(members: GChatMember[]): void {
  if (members.length === 0) {
    console.log('No members found');
    return;
  }

  console.log(`Members (${members.length})\n`);

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const label = m.user?.displayName || m.user?.name || '(unknown)';
    const email = m.user?.email ? ` <${m.user.email}>` : '';
    const roleTag = m.role === 'ROLE_MANAGER' ? ' [MANAGER]' : '';
    const typeTag = m.memberType === 'BOT' ? ' [BOT]' : '';
    const stateTag = m.state !== 'JOINED' ? ` [${m.state}]` : '';
    console.log(`[${i + 1}] ${label}${email}${roleTag}${typeTag}${stateTag}`);
    if (m.user?.name) {
      console.log(`    User ID: ${m.user.name}`);
    }
    if (m.user?.organizations?.length) {
      const org = m.user.organizations[0];
      const parts = [org.title, org.department, org.name].filter(Boolean);
      if (parts.length) console.log(`    ${parts.join(' · ')}`);
    }
  }
}

export function printGChatUser(user: GChatUser): void {
  console.log(`ID: ${user.name}`);
  if (user.displayName) console.log(`Name: ${user.displayName}`);
  if (user.email) console.log(`Email: ${user.email}`);
  if (user.phoneNumbers?.length) {
    console.log(`Phone: ${user.phoneNumbers.join(', ')}`);
  }
  if (user.organizations?.length) {
    console.log('Organizations:');
    for (const org of user.organizations) {
      const parts = [org.title, org.department, org.name].filter(Boolean);
      if (parts.length) console.log(`  - ${parts.join(' · ')}`);
    }
  }
  if (user.locations?.length) {
    console.log(`Location: ${user.locations.join(', ')}`);
  }
  if (user.photoUrl) {
    console.log(`Photo: ${user.photoUrl}`);
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

// Confluence specific formatters
export function printConfluenceSpaceList(spaces: ConfluenceSpace[]): void {
  if (spaces.length === 0) {
    console.log('No spaces found');
    return;
  }

  console.log(`Spaces (${spaces.length})\n`);

  for (const space of spaces) {
    console.log(`${space.key} - ${space.name}`);
    console.log(`    ID: ${space.id}`);
    console.log(`    Type: ${space.type} | Status: ${space.status}`);
    if (space.description) {
      const desc = space.description.length > 100
        ? space.description.slice(0, 100) + '...'
        : space.description;
      console.log(`    > ${desc}`);
    }
    console.log('');
  }
}

export function printConfluencePageList(pages: ConfluencePage[]): void {
  if (pages.length === 0) {
    console.log('No pages found');
    return;
  }

  console.log(`Pages (${pages.length})\n`);

  for (const page of pages) {
    console.log(`${page.id} | ${page.title}`);
    console.log(`    Space: ${page.spaceId} | Status: ${page.status} | v${page.version}`);
    if (page.parentId) console.log(`    Parent: ${page.parentId}`);
    console.log(`    Created: ${page.createdAt}`);
    if (page.webUrl) console.log(`    Link: ${page.webUrl}`);
    console.log('');
  }
}

export function printConfluencePage(page: ConfluencePageDetail): void {
  console.log(`ID: ${page.id}`);
  console.log(`Title: ${page.title}`);
  console.log(`Space: ${page.spaceId}`);
  console.log(`Status: ${page.status}`);
  console.log(`Version: ${page.version}`);
  if (page.parentId) console.log(`Parent: ${page.parentId}`);
  if (page.authorId) console.log(`Author: ${page.authorId}`);
  console.log(`Created: ${page.createdAt}`);
  if (page.webUrl) console.log(`Link: ${page.webUrl}`);
  if (page.body) {
    console.log('---');
    console.log(page.body);
  }
}

export function printConfluenceCommentList(comments: ConfluenceComment[]): void {
  if (comments.length === 0) {
    console.log('No comments');
    return;
  }

  console.log(`Comments (${comments.length})\n`);

  for (const c of comments) {
    console.log(`[${c.id}] v${c.version} ${c.createdAt}`);
    if (c.authorId) console.log(`    Author: ${c.authorId}`);
    const preview = c.body.length > 200 ? c.body.slice(0, 200) + '...' : c.body;
    console.log(`    > ${preview}`);
    console.log('');
  }
}

export function printConfluenceSearchResults(results: ConfluenceSearchResult[]): void {
  if (results.length === 0) {
    console.log('No results');
    return;
  }

  console.log(`Results (${results.length})\n`);

  for (const r of results) {
    console.log(`[${r.type}] ${r.id} | ${r.title}`);
    if (r.spaceKey) console.log(`    Space: ${r.spaceKey}`);
    if (r.lastModified) console.log(`    Modified: ${r.lastModified}`);
    if (r.url) console.log(`    Link: ${r.url}`);
    if (r.excerpt) {
      const snippet = r.excerpt.length > 150 ? r.excerpt.slice(0, 150) + '...' : r.excerpt;
      console.log(`    > ${snippet}`);
    }
    console.log('');
  }
}

export function printConfluencePageCreated(result: ConfluencePageCreateResult): void {
  console.log('Page created');
  console.log(`ID: ${result.id}`);
  console.log(`Title: ${result.title}`);
  console.log(`Space: ${result.spaceId}`);
  if (result.webUrl) console.log(`Link: ${result.webUrl}`);
}

export function printConfluencePageUpdated(result: ConfluencePageUpdateResult): void {
  console.log('Page updated');
  console.log(`ID: ${result.id}`);
  console.log(`Title: ${result.title}`);
  console.log(`Version: ${result.version}`);
}

export function printConfluenceCommentResult(result: ConfluenceCommentResult): void {
  console.log('Comment added');
  console.log(`Page: ${result.pageId}`);
  console.log(`Comment ID: ${result.id}`);
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

// Discourse specific formatters
export function printDiscourseCategoryList(categories: DiscourseCategory[]): void {
  if (categories.length === 0) {
    console.log('No categories found');
    return;
  }

  console.log(`Categories (${categories.length})\n`);

  for (const cat of categories) {
    const parentInfo = cat.parentCategoryId ? ' (subcategory)' : '';
    console.log(`[${cat.id}] ${cat.name}${parentInfo}`);
    console.log(`    Slug: ${cat.slug}`);
    console.log(`    Topics: ${cat.topicCount} | Posts: ${cat.postCount}`);
    if (cat.description) {
      const desc = cat.description.replace(/<[^>]*>/g, '').substring(0, 100);
      if (desc) console.log(`    > ${desc}${cat.description.length > 100 ? '...' : ''}`);
    }
    console.log('');
  }
}

export function printDiscourseTopicList(topics: DiscourseTopic[]): void {
  if (topics.length === 0) {
    console.log('No topics found');
    return;
  }

  console.log(`Topics (${topics.length})\n`);

  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    const flags: string[] = [];
    if (topic.pinned) flags.push('pinned');
    if (topic.closed) flags.push('closed');
    if (topic.archived) flags.push('archived');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

    console.log(`[${i + 1}] ${topic.id} | ${topic.title}${flagStr}`);
    if (topic.categoryName) console.log(`    Category: ${topic.categoryName}`);
    console.log(`    Posts: ${topic.postsCount} | Replies: ${topic.replyCount} | Views: ${topic.views} | Likes: ${topic.likeCount}`);
    console.log(`    Created: ${topic.createdAt}`);
    if (topic.lastPostedAt !== topic.createdAt) {
      console.log(`    Last Post: ${topic.lastPostedAt}`);
    }
    console.log('');
  }
}

export function printDiscourseTopic(topic: DiscourseTopicDetail): void {
  const flags: string[] = [];
  if (topic.pinned) flags.push('pinned');
  if (topic.closed) flags.push('closed');
  if (topic.archived) flags.push('archived');
  const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';

  console.log(`ID: ${topic.id}`);
  console.log(`Title: ${topic.title}${flagStr}`);
  console.log(`Slug: ${topic.slug}`);
  if (topic.categoryName) console.log(`Category: ${topic.categoryName}`);
  console.log(`Posts: ${topic.postsCount} | Replies: ${topic.replyCount} | Views: ${topic.views} | Likes: ${topic.likeCount}`);
  console.log(`Created: ${topic.createdAt}`);
  console.log(`Last Post: ${topic.lastPostedAt}`);
  console.log('---');

  for (const post of topic.posts) {
    const author = post.displayName || post.username;
    console.log(`\n[Post #${post.postNumber}] by ${author} (${post.createdAt})`);
    console.log(`Likes: ${post.likeCount} | Replies: ${post.replyCount}`);
    // Strip HTML from cooked content for display
    const content = post.cooked.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    console.log(content);
  }
}

// Google Docs specific formatters
export function printGDocsList(docs: GDocsDocument[]): void {
  if (docs.length === 0) {
    console.log('No documents found');
    return;
  }

  console.log(`Documents (${docs.length})\n`);

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    console.log(`[${i + 1}] ${doc.title}`);
    console.log(`    ID: ${doc.id}`);
    if (doc.owner) console.log(`    Owner: ${doc.owner}`);
    if (doc.modifiedTime) console.log(`    Modified: ${doc.modifiedTime}`);
    console.log(`    Link: ${doc.webViewLink}`);
    console.log('');
  }
}

export function printGDocCreated(result: GDocsCreateResult): void {
  console.log('Document created');
  console.log(`ID: ${result.id}`);
  console.log(`Title: ${result.title}`);
  console.log(`Link: ${result.webViewLink}`);
}

export function printGDocsBatchResult(result: GDocsBatchResult): void {
  console.error(`Batch update applied to ${result.documentId} (${result.replies.length} replies)`);
  console.log(JSON.stringify({ documentId: result.documentId, replies: result.replies }, null, 2));
}

// Google Sheets specific formatters
import type {
  GSheetsListItem,
  GSheetsSpreadsheet,
  GSheetsGetResult,
  GSheetsUpdateResult,
  GSheetsAppendResult,
  GSheetsClearResult,
  GSheetsCreateResult,
  GSheetsFormatResult,
  GSheetsResizeResult,
  GSheetsBatchResult,
} from '../types/gsheets';

export function printGSheetsList(spreadsheets: GSheetsListItem[]): void {
  if (spreadsheets.length === 0) {
    console.log('No spreadsheets found');
    return;
  }

  console.log(`Spreadsheets (${spreadsheets.length})\n`);

  for (let i = 0; i < spreadsheets.length; i++) {
    const sheet = spreadsheets[i];
    console.log(`[${i + 1}] ${sheet.title}`);
    console.log(`    ID: ${sheet.id}`);
    if (sheet.owner) console.log(`    Owner: ${sheet.owner}`);
    if (sheet.modifiedTime) console.log(`    Modified: ${sheet.modifiedTime}`);
    console.log(`    Link: ${sheet.webViewLink}`);
    console.log('');
  }
}

export function printGSheetsMetadata(spreadsheet: GSheetsSpreadsheet): void {
  console.log(`ID: ${spreadsheet.id}`);
  console.log(`Title: ${spreadsheet.title}`);
  if (spreadsheet.locale) console.log(`Locale: ${spreadsheet.locale}`);
  if (spreadsheet.timeZone) console.log(`TimeZone: ${spreadsheet.timeZone}`);
  console.log(`URL: ${spreadsheet.url}`);
  console.log('');
  console.log('Sheets:');

  for (const sheet of spreadsheet.sheets) {
    console.log(`  [${sheet.id}] ${sheet.title} (${sheet.rowCount} rows x ${sheet.columnCount} cols)`);
  }
}

export function printGSheetsValues(result: GSheetsGetResult): void {
  if (result.values.length === 0) {
    console.log('No data found');
    return;
  }

  console.log(`Range: ${result.range}\n`);

  for (const row of result.values) {
    const cells = row.map((cell) => String(cell ?? ''));
    console.log(cells.join('\t'));
  }
}

export function printGSheetsUpdateResult(result: GSheetsUpdateResult): void {
  console.log(`Updated ${result.updatedCells} cells in ${result.updatedRange}`);
  console.log(`  Rows: ${result.updatedRows}`);
  console.log(`  Columns: ${result.updatedColumns}`);
}

export function printGSheetsAppendResult(result: GSheetsAppendResult): void {
  console.log(`Appended ${result.updatedCells} cells to ${result.updatedRange}`);
  console.log(`  Rows: ${result.updatedRows}`);
  console.log(`  Columns: ${result.updatedColumns}`);
}

export function printGSheetsClearResult(result: GSheetsClearResult): void {
  console.log(`Cleared ${result.clearedRange}`);
}

export function printGSheetsCreated(result: GSheetsCreateResult): void {
  console.log('Spreadsheet created');
  console.log(`ID: ${result.id}`);
  console.log(`Title: ${result.title}`);
  console.log(`URL: ${result.url}`);
}

export function printGSheetsFormatResult(result: GSheetsFormatResult): void {
  console.log(`Formatted ${result.range}`);
  console.log(`  Sheet: ${result.sheetTitle}`);
  if (result.cleared) console.log('  Cleared existing formatting');
  if (result.appliedFields.length > 0) {
    console.log(`  Applied: ${result.appliedFields.join(', ')}`);
  }
  if (result.merged) console.log('  Merged: yes');
}

export function printGSheetsResizeResult(result: GSheetsResizeResult): void {
  const unit = result.dimension === 'COLUMNS' ? 'column(s)' : 'row(s)';
  const how = result.auto ? 'auto-fit' : `${result.pixelSize}px`;
  console.log(`Resized ${result.count} ${unit} in ${result.range}`);
  console.log(`  Sheet: ${result.sheetTitle}`);
  console.log(`  Size: ${how}`);
}

export function printGSheetsBatchResult(result: GSheetsBatchResult): void {
  console.log(`Batch update applied to ${result.spreadsheetId}`);
  console.log(`  Replies: ${result.replies}`);
}

// Google Slides specific formatters
export function printGSlidesList(items: GSlidesListItem[]): void {
  if (items.length === 0) {
    console.log('No presentations found');
    return;
  }

  console.log(`Presentations (${items.length})\n`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`[${i + 1}] ${item.title}`);
    console.log(`    ID: ${item.id}`);
    if (item.owner) console.log(`    Owner: ${item.owner}`);
    if (item.modifiedTime) console.log(`    Modified: ${item.modifiedTime}`);
    console.log(`    Link: ${item.webViewLink}`);
    console.log('');
  }
}

export function printGSlidesMetadata(presentation: GSlidesPresentation): void {
  console.log(`ID: ${presentation.id}`);
  console.log(`Title: ${presentation.title}`);
  console.log(`URL: ${presentation.url}`);
  console.log(`Slides: ${presentation.slideCount}`);

  if (presentation.width !== undefined && presentation.height !== undefined) {
    const w = (presentation.width / 914400).toFixed(2);
    const h = (presentation.height / 914400).toFixed(2);
    console.log(`Dimensions: ${w}" × ${h}"`);
  }

  if (presentation.slides.length > 0) {
    console.log('\nSlide index:');
    for (const slide of presentation.slides) {
      const titlePart = slide.title ? ` — ${slide.title}` : '';
      console.log(`  [${slide.index}] ${slide.objectId}${titlePart}`);
    }
  }
}

export function printGSlidesContent(slides: GSlidesSlideContent[]): void {
  if (slides.length === 0) {
    console.log('No slides found');
    return;
  }

  for (const slide of slides) {
    console.log(`\n--- Slide ${slide.index + 1} (${slide.objectId}) ---`);

    if (slide.elements.length > 0) {
      for (const element of slide.elements) {
        console.log(element.text);
      }
    } else {
      console.log('(no text content)');
    }

    if (slide.notes) {
      console.log('\nNotes:');
      console.log(slide.notes);
    }
  }
}

export function printGSlidesCreated(result: GSlidesCreateResult): void {
  console.log('Presentation created');
  console.log(`ID: ${result.id}`);
  console.log(`Title: ${result.title}`);
  console.log(`URL: ${result.url}`);
}

export function printGSlidesBatchResult(result: GSlidesBatchResult): void {
  console.log(`Batch update applied to ${result.presentationId}`);
  console.log(`  Replies: ${result.replies}`);
}

// Google Apps Script specific formatters
export function printGScriptProject(project: GScriptProject): void {
  console.log(`Script ID: ${project.scriptId}`);
  console.log(`Title: ${project.title}`);
  if (project.parentId) console.log(`Bound to: ${project.parentId}`);
  if (project.createTime) console.log(`Created: ${project.createTime}`);
  if (project.updateTime) console.log(`Updated: ${project.updateTime}`);
  if (project.creator) console.log(`Creator: ${project.creator}`);
  if (project.lastModifyUser) console.log(`Last modified by: ${project.lastModifyUser}`);
  console.log(`URL: ${project.url}`);
}

export function printGScriptList(items: GScriptListItem[]): void {
  if (items.length === 0) {
    console.log('No script projects found');
    return;
  }

  console.log(`Script projects (${items.length})\n`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const bound = item.parentId ? `  [bound to ${item.parentId}]` : '';
    console.log(`[${i + 1}] ${item.title}${bound}`);
    console.log(`    ID: ${item.scriptId}`);
    if (item.modifiedTime) console.log(`    Modified: ${item.modifiedTime}`);
    console.log('');
  }
}

export function printGScriptPullResult(result: GScriptPullResult): void {
  console.log(`Pulled ${result.files.length} file(s) from ${result.scriptId} into ${result.rootDir}`);
  for (const file of result.files) {
    console.log(`  ${file.localPath} (${file.type})`);
  }
}

export function printGScriptPushResult(result: GScriptPushResult): void {
  console.log(`Pushed ${result.files.length} file(s) to ${result.scriptId}`);
  for (const file of result.files) {
    console.log(`  ${file.name} (${file.type})`);
  }
}

// Google Drive specific formatters
function getShortMimeType(mimeType: string): string {
  const shortTypes: Record<string, string> = {
    'application/vnd.google-apps.folder': 'folder',
    'application/vnd.google-apps.document': 'gdoc',
    'application/vnd.google-apps.spreadsheet': 'gsheet',
    'application/vnd.google-apps.presentation': 'gslide',
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'text/plain': 'txt',
    'application/zip': 'zip',
  };
  if (shortTypes[mimeType]) return shortTypes[mimeType];
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/')) return 'text';
  return 'file';
}

export function printGDriveFileList(files: GDriveFile[], title: string = 'Files'): void {
  if (files.length === 0) {
    console.log('No files found');
    return;
  }

  console.log(`${title} (${files.length})\n`);

  for (const file of files) {
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    const type = getShortMimeType(file.mimeType).padEnd(7);
    const size = file.size ? formatBytes(file.size).padStart(8) : '       -';
    const date = file.modifiedTime ? file.modifiedTime.slice(0, 10) : '          ';
    const flags = (file.starred ? '*' : '') + (file.shared ? '⇄' : '');
    const name = isFolder ? `${file.name}/` : file.name;
    console.log(`${type} ${size}  ${date}  ${flags.padEnd(2)} ${name}`);
    console.log(`  ${file.id}`);
  }
}

export function printGDriveFile(file: GDriveFile): void {
  console.log(`ID: ${file.id}`);
  console.log(`Name: ${file.name}`);
  console.log(`Type: ${file.mimeType}`);
  if (file.size) console.log(`Size: ${formatBytes(file.size)}`);
  if (file.description) console.log(`Description: ${file.description}`);
  if (file.owners?.length) console.log(`Owners: ${file.owners.join(', ')}`);
  if (file.parents?.length) console.log(`Parents: ${file.parents.join(', ')}`);
  console.log(`Starred: ${file.starred ? 'yes' : 'no'}`);
  console.log(`Shared: ${file.shared ? 'yes' : 'no'}`);
  console.log(`Trashed: ${file.trashed ? 'yes' : 'no'}`);
  if (file.createdTime) console.log(`Created: ${file.createdTime}`);
  if (file.modifiedTime) console.log(`Modified: ${file.modifiedTime}`);
  if (file.webViewLink) console.log(`View: ${file.webViewLink}`);
  if (file.webContentLink) console.log(`Download: ${file.webContentLink}`);
}

export function printGDriveDownloaded(result: GDriveDownloadResult): void {
  console.log(`Downloaded: ${result.filename}`);
  console.log(`  Path: ${result.path}`);
  console.log(`  Size: ${formatBytes(result.size)}`);
  console.log(`  Type: ${result.mimeType}`);
}

export function printGDriveUploaded(result: GDriveUploadResult): void {
  console.log(`Uploaded: ${result.name}`);
  console.log(`  ID: ${result.id}`);
  console.log(`  Size: ${formatBytes(result.size)}`);
  console.log(`  Type: ${result.mimeType}`);
  if (result.webViewLink) console.log(`  Link: ${result.webViewLink}`);
}

export function printGDriveCopied(result: GDriveCopyResult): void {
  console.log(`Copied: ${result.name}`);
  console.log(`  ID: ${result.id}`);
  console.log(`  Type: ${result.mimeType}`);
  if (result.parents && result.parents.length > 0) console.log(`  Folder: ${result.parents[0]}`);
  if (result.webViewLink) console.log(`  Link: ${result.webViewLink}`);
}

export function printGDriveShared(result: GDriveShareResult, fileId: string): void {
  console.log('Permission created');
  console.log(`  Permission ID: ${result.permissionId}`);
  console.log(`  Type: ${result.type}`);
  console.log(`  Role: ${result.role}`);
  if (result.emailAddress) console.log(`  Email: ${result.emailAddress}`);
  if (result.domain) console.log(`  Domain: ${result.domain}`);
  if (result.type === 'anyone') {
    console.log(`  Public URL: https://drive.google.com/uc?id=${fileId}`);
  }
}

export function printGDrivePermissions(permissions: GDrivePermission[]): void {
  if (permissions.length === 0) {
    console.log('No permissions found');
    return;
  }

  console.log(`Permissions (${permissions.length})\n`);

  for (const p of permissions) {
    const target = p.emailAddress || p.domain || p.type;
    const discovery = p.type === 'anyone' && p.allowFileDiscovery ? ' (discoverable)' : '';
    console.log(`  ${p.role.padEnd(10)} ${target}${discovery}`);
    console.log(`    ID: ${p.id}`);
    if (p.displayName) console.log(`    Name: ${p.displayName}`);
  }
}

// Google Calendar specific formatters
function getEventDateTime(dt: { dateTime?: string; date?: string }): string {
  return dt.dateTime || dt.date || '';
}

export function printGCalCalendarList(calendars: GCalCalendar[]): void {
  if (calendars.length === 0) {
    console.log('No calendars found');
    return;
  }

  console.log(`Calendars (${calendars.length})\n`);

  for (let i = 0; i < calendars.length; i++) {
    const cal = calendars[i];
    const primaryBadge = cal.primary ? ' [primary]' : '';
    console.log(`[${i + 1}] ${cal.summary}${primaryBadge}`);
    console.log(`    ID: ${cal.id}`);
    console.log(`    Role: ${cal.accessRole}`);
    if (cal.timeZone) console.log(`    Timezone: ${cal.timeZone}`);
    if (cal.description) {
      const desc = cal.description.length > 80
        ? cal.description.slice(0, 80) + '...'
        : cal.description;
      console.log(`    > ${desc}`);
    }
    console.log('');
  }
}

export function printGCalEventList(events: GCalEvent[], nextPageToken?: string): void {
  if (events.length === 0) {
    console.log('No events found');
    return;
  }

  console.log(`Events (${events.length})\n`);

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const start = getEventDateTime(event.start);
    const end = getEventDateTime(event.end);
    const title = event.summary || '(no title)';

    console.log(`[${i + 1}] ${event.id}`);
    console.log(`    ${title}`);
    console.log(`    Start: ${start}`);
    console.log(`    End: ${end}`);
    if (event.location) console.log(`    Location: ${event.location}`);
    if (event.attendees?.length) {
      console.log(`    Attendees: ${event.attendees.length}`);
    }
    if (event.hangoutLink) console.log(`    Meet: ${event.hangoutLink}`);
    console.log('');
  }

  if (nextPageToken) {
    console.log(`(more results available, use --page ${nextPageToken})`);
  }
}

export function printGCalEvent(event: GCalEvent): void {
  console.log(`ID: ${event.id}`);
  console.log(`Summary: ${event.summary || '(no title)'}`);

  if (event.eventType && event.eventType !== 'default') {
    console.log(`Type: ${event.eventType}`);
  }

  const start = getEventDateTime(event.start);
  const end = getEventDateTime(event.end);
  console.log(`Start: ${start}`);
  console.log(`End: ${end}`);

  if (event.start.timeZone) console.log(`Timezone: ${event.start.timeZone}`);
  if (event.location) console.log(`Location: ${event.location}`);
  if (event.description) console.log(`Description: ${event.description}`);

  if (event.colorId) console.log(`Color: ${event.colorId}`);
  if (event.visibility && event.visibility !== 'default') {
    console.log(`Visibility: ${event.visibility}`);
  }
  if (event.transparency === 'transparent') {
    console.log(`Show as: free`);
  }

  if (event.attendees?.length) {
    console.log(`\nAttendees (${event.attendees.length}):`);
    for (const a of event.attendees) {
      const status = a.responseStatus || 'unknown';
      const optional = a.optional ? ' (optional)' : '';
      const organizer = a.organizer ? ' [organizer]' : '';
      const self = a.self ? ' [you]' : '';
      console.log(`  ${a.email} - ${status}${optional}${organizer}${self}`);
    }
  }

  if (event.recurrence?.length) {
    console.log(`Recurrence: ${event.recurrence.join('; ')}`);
  }

  if (event.reminders) {
    if (event.reminders.useDefault) {
      console.log(`Reminders: (calendar default)`);
    } else if (event.reminders.overrides?.length) {
      const parts = event.reminders.overrides.map(r => `${r.method}:${r.minutes}m`);
      console.log(`Reminders: ${parts.join(', ')}`);
    }
  }

  if (event.hangoutLink) console.log(`Meet: ${event.hangoutLink}`);
  if (event.conferenceData?.entryPoints?.length) {
    for (const ep of event.conferenceData.entryPoints) {
      if (ep.entryPointType === 'video') {
        console.log(`Video: ${ep.uri}`);
      }
    }
  }

  if (event.htmlLink) console.log(`Link: ${event.htmlLink}`);
}

export function printGCalEventCreated(event: GCalEvent): void {
  console.log('Event created');
  console.log(`ID: ${event.id}`);
  console.log(`Summary: ${event.summary || '(no title)'}`);
  console.log(`Start: ${getEventDateTime(event.start)}`);
  console.log(`End: ${getEventDateTime(event.end)}`);
  if (event.hangoutLink) console.log(`Meet: ${event.hangoutLink}`);
  if (event.htmlLink) console.log(`Link: ${event.htmlLink}`);
}

export function printGCalEventDeleted(calendarId: string, eventId: string): void {
  console.log('Event deleted');
  console.log(`Calendar: ${calendarId}`);
  console.log(`Event ID: ${eventId}`);
}

export function printGCalFreeBusy(result: GCalFreeBusyResponse): void {
  const calendars = Object.entries(result.calendars);
  if (calendars.length === 0) {
    console.log('No free/busy data');
    return;
  }

  console.log('Free/Busy Information\n');

  for (const [calendarId, data] of calendars) {
    console.log(`Calendar: ${calendarId}`);
    if (data.errors?.length) {
      for (const err of data.errors) {
        console.log(`  Error: ${err.reason}`);
      }
    }
    if (data.busy.length === 0) {
      console.log('  (no busy periods)');
    } else {
      for (const b of data.busy) {
        console.log(`  Busy: ${b.start} - ${b.end}`);
      }
    }
    console.log('');
  }
}

// Google Tasks specific formatters
export function printGTasksList(taskLists: GTaskList[], nextPageToken?: string): void {
  if (taskLists.length === 0) {
    console.log('No task lists found');
    return;
  }

  console.log(`Task Lists (${taskLists.length})\n`);

  for (let i = 0; i < taskLists.length; i++) {
    const tl = taskLists[i];
    console.log(`[${i + 1}] ${tl.title}`);
    console.log(`    ID: ${tl.id}`);
    if (tl.updated) console.log(`    Updated: ${tl.updated}`);
    console.log('');
  }

  if (nextPageToken) {
    console.log(`(more results available)`);
  }
}

export function printGTaskList(taskList: GTaskList): void {
  console.log(`ID: ${taskList.id}`);
  console.log(`Title: ${taskList.title}`);
  if (taskList.updated) console.log(`Updated: ${taskList.updated}`);
  if (taskList.selfLink) console.log(`Link: ${taskList.selfLink}`);
}

export function printGTaskListCreated(taskList: GTaskList): void {
  console.log('Task list created');
  console.log(`ID: ${taskList.id}`);
  console.log(`Title: ${taskList.title}`);
}

export function printGTaskListDeleted(tasklistId: string): void {
  console.log('Task list deleted');
  console.log(`ID: ${tasklistId}`);
}

export function printGTasks(tasks: GTask[], nextPageToken?: string): void {
  if (tasks.length === 0) {
    console.log('No tasks found');
    return;
  }

  console.log(`Tasks (${tasks.length})\n`);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const statusIcon = task.status === 'completed' ? '[x]' : '[ ]';
    const dueStr = task.due ? ` (due: ${task.due.split('T')[0]})` : '';

    console.log(`[${i + 1}] ${statusIcon} ${task.title}${dueStr}`);
    console.log(`    ID: ${task.id}`);
    console.log(`    Status: ${task.status}`);
    if (task.notes) {
      const preview = task.notes.length > 60 ? task.notes.slice(0, 60) + '...' : task.notes;
      console.log(`    > ${preview}`);
    }
    console.log('');
  }

  if (nextPageToken) {
    console.log(`(more results available)`);
  }
}

export function printGTask(task: GTask): void {
  console.log(`ID: ${task.id}`);
  console.log(`Title: ${task.title}`);
  console.log(`Status: ${task.status}`);
  if (task.due) console.log(`Due: ${task.due}`);
  if (task.completed) console.log(`Completed: ${task.completed}`);
  if (task.updated) console.log(`Updated: ${task.updated}`);
  if (task.parent) console.log(`Parent: ${task.parent}`);
  if (task.webViewLink) console.log(`Link: ${task.webViewLink}`);
  if (task.notes) {
    console.log('---');
    console.log(task.notes);
  }
}

export function printGTaskCreated(task: GTask): void {
  console.log('Task created');
  console.log(`ID: ${task.id}`);
  console.log(`Title: ${task.title}`);
  console.log(`Status: ${task.status}`);
  if (task.due) console.log(`Due: ${task.due}`);
  if (task.webViewLink) console.log(`Link: ${task.webViewLink}`);
}

export function printGTaskDeleted(tasklistId: string, taskId: string): void {
  console.log('Task deleted');
  console.log(`Task List: ${tasklistId}`);
  console.log(`Task ID: ${taskId}`);
}

export function printGTasksCleared(tasklistId: string): void {
  console.log('Completed tasks cleared');
  console.log(`Task List: ${tasklistId}`);
}


function resolveLabelNames(ids: string[] | undefined, labelNamesById: Map<string, string>): string[] {
  if (!ids?.length) return [];
  return ids.map((id) => labelNamesById.get(id) ?? id);
}

function summarizeFilterCriteria(c: GmailFilterCriteria): string {
  const parts: string[] = [];
  if (c.from) parts.push(`from:${c.from}`);
  if (c.to) parts.push(`to:${c.to}`);
  if (c.subject) parts.push(`subject:${c.subject}`);
  if (c.query) parts.push(`query:${c.query}`);
  if (c.negatedQuery) parts.push(`-query:${c.negatedQuery}`);
  if (c.hasAttachment) parts.push('has:attachment');
  if (c.excludeChats) parts.push('exclude:chats');
  if (typeof c.size === 'number' && c.sizeComparison) {
    parts.push(`size:${c.sizeComparison}:${c.size}`);
  }
  return parts.length ? parts.join(' ') : '(no criteria)';
}

function summarizeFilterAction(a: GmailFilterAction, labelNamesById: Map<string, string>): string {
  const parts: string[] = [];
  for (const name of resolveLabelNames(a.addLabelIds, labelNamesById)) parts.push(`+${name}`);
  for (const name of resolveLabelNames(a.removeLabelIds, labelNamesById)) parts.push(`-${name}`);
  if (a.forward) parts.push(`forward:${a.forward}`);
  return parts.length ? parts.join(' ') : '(no action)';
}

export function printFilterList(filters: GmailFilter[], labelNamesById: Map<string, string>): void {
  if (filters.length === 0) {
    console.log('No filters found');
    return;
  }
  const idWidth = Math.max(2, ...filters.map((f) => f.id.length));
  for (const filter of filters) {
    const criteria = summarizeFilterCriteria(filter.criteria);
    const action = summarizeFilterAction(filter.action, labelNamesById);
    console.log(`${filter.id.padEnd(idWidth)}  ${criteria}  ->  ${action}`);
  }
  console.log(`\n${filters.length} filter(s)`);
}

export function printFilter(filter: GmailFilter, labelNamesById: Map<string, string>): void {
  console.log(`ID:       ${filter.id}`);

  const c = filter.criteria;
  const criteriaLines: string[] = [];
  if (c.from) criteriaLines.push(`  From:           ${c.from}`);
  if (c.to) criteriaLines.push(`  To:             ${c.to}`);
  if (c.subject) criteriaLines.push(`  Subject:        ${c.subject}`);
  if (c.query) criteriaLines.push(`  Query:          ${c.query}`);
  if (c.negatedQuery) criteriaLines.push(`  Negated query:  ${c.negatedQuery}`);
  if (c.hasAttachment) criteriaLines.push(`  Has attachment: yes`);
  if (c.excludeChats) criteriaLines.push(`  Exclude chats:  yes`);
  if (typeof c.size === 'number' && c.sizeComparison) {
    criteriaLines.push(`  Size:           ${c.sizeComparison} ${c.size} bytes`);
  }
  if (criteriaLines.length) {
    console.log('Criteria:');
    for (const line of criteriaLines) console.log(line);
  }

  const a = filter.action;
  const actionLines: string[] = [];
  const apply = resolveLabelNames(a.addLabelIds, labelNamesById);
  const remove = resolveLabelNames(a.removeLabelIds, labelNamesById);
  if (apply.length) actionLines.push(`  Apply labels:   ${apply.join(', ')}`);
  if (remove.length) actionLines.push(`  Remove labels:  ${remove.join(', ')}`);
  if (a.forward) actionLines.push(`  Forward:        ${a.forward}`);
  if (actionLines.length) {
    console.log('Action:');
    for (const line of actionLines) console.log(line);
  }
}

export function printFilterCreated(filter: GmailFilter, labelNamesById: Map<string, string>): void {
  console.log(`Created filter: ${filter.id}`);
  console.log(`  ${summarizeFilterCriteria(filter.criteria)}  ->  ${summarizeFilterAction(filter.action, labelNamesById)}`);
}

export function printFilterDeleted(id: string): void {
  console.log(`Deleted filter: ${id}`);
}
