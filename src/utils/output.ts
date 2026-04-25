import { homedir } from 'os';
import type { GmailMessage, GmailAttachmentInfo } from '../types/gmail';
import type { GChatMessage, GChatSpace, GChatMember, GChatUser } from '../types/gchat';
import type { GDocsDocument, GDocsCreateResult } from '../types/gdocs';
import type { GDriveFile, GDriveDownloadResult, GDriveUploadResult } from '../types/gdrive';
import type { GCalCalendar, GCalEvent, GCalFreeBusyResponse } from '../types/gcal';
import type { GTaskList, GTask } from '../types/gtasks';
import type { JiraProject, JiraIssue, JiraTransition, JiraCommentResult, JiraTransitionResult } from '../types/jira';
import type { SlackSendResult } from '../types/slack';
import type { RssFeed, RssArticle } from '../types/rss';
import type { DiscourseCategory, DiscourseTopic, DiscourseTopicDetail } from '../types/discourse';

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

// Format draft creation result
export function printDraftResult(result: { id: string; messageId: string }): void {
  console.log('Draft created');
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

// Gateway inbox/outbox formatters
import type { InboundMessage, OutboundMessage } from '../daemon/types';

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
