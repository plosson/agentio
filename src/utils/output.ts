import type { GmailMessage, GmailAttachmentInfo } from '../types/gmail';
import type { GChatMessage, GChatSpace } from '../types/gchat';
import type { GDocsDocument, GDocsCreateResult } from '../types/gdocs';
import type { GDriveFile, GDriveDownloadResult, GDriveUploadResult } from '../types/gdrive';
import type { JiraProject, JiraIssue, JiraTransition, JiraCommentResult, JiraTransitionResult } from '../types/jira';
import type { SlackSendResult } from '../types/slack';
import type { RssFeed, RssArticle } from '../types/rss';
import type { DiscourseCategory, DiscourseTopic, DiscourseTopicDetail } from '../types/discourse';

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

export function printGChatSpaceList(spaces: GChatSpace[]): void {
  if (spaces.length === 0) {
    console.log('No spaces found');
    return;
  }

  console.log(`Spaces (${spaces.length})\n`);

  for (const space of spaces) {
    const spaceId = space.name.replace('spaces/', '');
    console.log(`[${space.type}] ${space.displayName}`);
    console.log(`    ID: ${spaceId}`);
    if (space.description) {
      console.log(`    Description: ${space.description}`);
    }
    console.log('');
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

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
    const typeIndicator = isFolder ? '[folder]' : `[${getShortMimeType(file.mimeType)}]`;
    const flags: string[] = [];
    if (file.starred) flags.push('*');
    if (file.shared) flags.push('shared');
    const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';

    console.log(`[${i + 1}] ${file.name} ${typeIndicator}${flagStr}`);
    console.log(`    ID: ${file.id}`);
    if (file.size) console.log(`    Size: ${formatBytes(file.size)}`);
    if (file.owners?.length) console.log(`    Owner: ${file.owners[0]}`);
    if (file.modifiedTime) console.log(`    Modified: ${file.modifiedTime}`);
    if (file.webViewLink) console.log(`    Link: ${file.webViewLink}`);
    console.log('');
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

// Gateway inbox/outbox formatters
import type { InboundMessage, OutboundMessage } from '../gateway/types';

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').split('.')[0];
}

export function printInboxMessageList(messages: InboundMessage[]): void {
  if (messages.length === 0) {
    console.log('No messages');
    return;
  }

  console.log(`Messages (${messages.length})\n`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const statusIcon = msg.status === 'pending' ? '○' : '●';
    const senderDisplay = msg.senderName || msg.senderHandle || msg.senderId;

    console.log(`[${i + 1}] ${statusIcon} ${msg.id.slice(0, 8)}`);
    console.log(`    Service: ${msg.service}:${msg.profile}`);
    console.log(`    From: ${senderDisplay}`);
    console.log(`    Chat: ${msg.conversationId}`);
    console.log(`    Date: ${formatTimestamp(msg.receivedAt)}`);
    if (msg.content) {
      const preview = msg.content.length > 100 ? msg.content.slice(0, 100) + '...' : msg.content;
      console.log(`    > ${preview}`);
    }
    if (msg.mediaType) {
      console.log(`    Media: ${msg.mediaType}`);
    }
    console.log('');
  }
}

export function printInboxMessage(msg: InboundMessage): void {
  console.log(`ID: ${msg.id}`);
  console.log(`Service: ${msg.service}`);
  console.log(`Profile: ${msg.profile}`);
  console.log(`Status: ${msg.status}`);
  console.log(`Conversation: ${msg.conversationId}`);
  console.log(`Platform ID: ${msg.platformId}`);
  console.log('');
  console.log(`From: ${msg.senderName || 'Unknown'}`);
  if (msg.senderHandle) console.log(`Handle: ${msg.senderHandle}`);
  console.log(`Sender ID: ${msg.senderId}`);
  console.log('');
  console.log(`Received: ${formatTimestamp(msg.receivedAt)}`);
  if (msg.doneAt) console.log(`Done: ${formatTimestamp(msg.doneAt)}`);
  if (msg.replyToId) console.log(`Reply To: ${msg.replyToId}`);
  if (msg.mediaType) {
    console.log(`Media Type: ${msg.mediaType}`);
    if (msg.mediaPath) console.log(`Media: ${msg.mediaPath}`);
  }
  console.log('---');
  console.log(msg.content || '[No text content]');
}

export function printInboxStats(stats: { pending: number; done: number; total: number }): void {
  console.log('Inbox Statistics');
  console.log(`  Pending: ${stats.pending}`);
  console.log(`  Done: ${stats.done}`);
  console.log(`  Total: ${stats.total}`);
}

export function printOutboxMessageList(messages: OutboundMessage[]): void {
  if (messages.length === 0) {
    console.log('No messages');
    return;
  }

  console.log(`Messages (${messages.length})\n`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let statusIcon = '○';
    if (msg.status === 'sending') statusIcon = '◐';
    else if (msg.status === 'sent') statusIcon = '●';
    else if (msg.status === 'failed') statusIcon = '✗';

    console.log(`[${i + 1}] ${statusIcon} ${msg.id.slice(0, 8)} [${msg.status}]`);
    console.log(`    Service: ${msg.service}:${msg.profile}`);
    console.log(`    To: ${msg.conversationId}`);
    console.log(`    Queued: ${formatTimestamp(msg.queuedAt)}`);
    if (msg.sentAt) console.log(`    Sent: ${formatTimestamp(msg.sentAt)}`);
    if (msg.error) console.log(`    Error: ${msg.error}`);
    if (msg.content) {
      const preview = msg.content.length > 80 ? msg.content.slice(0, 80) + '...' : msg.content;
      console.log(`    > ${preview}`);
    }
    console.log('');
  }
}

export function printOutboxMessage(msg: OutboundMessage): void {
  console.log(`ID: ${msg.id}`);
  console.log(`Service: ${msg.service}`);
  console.log(`Profile: ${msg.profile}`);
  console.log(`Status: ${msg.status}`);
  console.log(`Conversation: ${msg.conversationId}`);
  console.log('');
  console.log(`Queued: ${formatTimestamp(msg.queuedAt)}`);
  if (msg.sentAt) console.log(`Sent: ${formatTimestamp(msg.sentAt)}`);
  if (msg.platformId) console.log(`Platform ID: ${msg.platformId}`);
  if (msg.error) console.log(`Error: ${msg.error}`);
  if (msg.replyToPlatformId) console.log(`Reply To: ${msg.replyToPlatformId}`);
  if (msg.mediaType) {
    console.log(`Media Type: ${msg.mediaType}`);
    if (msg.mediaPath) console.log(`Media: ${msg.mediaPath}`);
  }
  console.log('---');
  console.log(msg.content || '[No text content]');
}

export function printOutboxSendResult(result: { id: string; status: string }): void {
  console.log('Message queued');
  console.log(`  ID: ${result.id}`);
  console.log(`  Status: ${result.status}`);
}

export function printInboxAckResult(success: boolean, id: string): void {
  if (success) {
    console.log(`Acknowledged: ${id}`);
  } else {
    console.log(`Already acknowledged or not found: ${id}`);
  }
}

export function printInboxReplyResult(result: { outboxId: string; status: string }): void {
  console.log('Reply queued');
  console.log(`  Outbox ID: ${result.outboxId}`);
  console.log(`  Status: ${result.status}`);
}

// WhatsApp Group formatters
import type { WhatsAppGroup } from '../types/whatsapp';

export function printWhatsAppGroupList(groups: WhatsAppGroup[]): void {
  if (groups.length === 0) {
    console.log('No groups found');
    return;
  }

  console.log(`Groups (${groups.length})\n`);

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const adminBadge = group.isSuperAdmin ? ' [owner]' : group.isAdmin ? ' [admin]' : '';
    const flags: string[] = [];
    if (group.announce) flags.push('announce');
    if (group.restrict) flags.push('restricted');
    const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';

    console.log(`[${i + 1}] ${group.name}${adminBadge}${flagStr}`);
    console.log(`    ID: ${group.id}`);
    console.log(`    Participants: ${group.participantCount}`);
    if (group.description) {
      const desc = group.description.length > 80
        ? group.description.slice(0, 80) + '...'
        : group.description;
      console.log(`    > ${desc}`);
    }
    console.log('');
  }
}

export function printWhatsAppGroup(group: WhatsAppGroup): void {
  console.log(`Name: ${group.name}`);
  console.log(`ID: ${group.id}`);

  const roles: string[] = [];
  if (group.isSuperAdmin) roles.push('owner');
  else if (group.isAdmin) roles.push('admin');
  if (roles.length > 0) console.log(`Your Role: ${roles.join(', ')}`);

  console.log(`Participants: ${group.participantCount}`);

  const settings: string[] = [];
  if (group.announce) settings.push('only admins can send');
  if (group.restrict) settings.push('only admins can edit info');
  if (settings.length > 0) console.log(`Settings: ${settings.join(', ')}`);

  if (group.owner) console.log(`Owner: ${group.owner}`);
  if (group.creation) {
    console.log(`Created: ${new Date(group.creation * 1000).toISOString().split('T')[0]}`);
  }

  if (group.description) {
    console.log('---');
    console.log(group.description);
  }

  if (group.participants && group.participants.length > 0) {
    console.log('\nParticipants:');
    for (const p of group.participants) {
      const role = p.isSuperAdmin ? ' (owner)' : p.isAdmin ? ' (admin)' : '';
      const name = p.name ? ` - ${p.name}` : '';
      console.log(`  ${p.phone}${name}${role}`);
    }
  }
}

export function printWhatsAppGroupCreated(group: WhatsAppGroup): void {
  console.log('Group created');
  console.log(`  Name: ${group.name}`);
  console.log(`  ID: ${group.id}`);
  console.log(`  Participants: ${group.participantCount}`);
}

export function printWhatsAppGroupInvite(result: { inviteCode: string; inviteLink: string }): void {
  console.log('Group invite link:');
  console.log(`  ${result.inviteLink}`);
  console.log(`  Code: ${result.inviteCode}`);
}

export function printWhatsAppGroupJoined(groupId: string): void {
  console.log('Joined group');
  console.log(`  ID: ${groupId}`);
}

export function printWhatsAppGroupLeft(groupId: string): void {
  console.log(`Left group: ${groupId}`);
}

export function printWhatsAppParticipantsResult(
  action: string,
  results: { participant: string; status: string }[]
): void {
  console.log(`Participants ${action}:`);
  for (const r of results) {
    console.log(`  ${r.participant}: ${r.status}`);
  }
}
