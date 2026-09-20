import type { GmailMessage, GmailAttachmentInfo, GmailLabel, GmailFilter, GmailFilterCriteria, GmailFilterAction } from './types';
import { formatBytes } from '../format';
export { raw } from '../format';

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

// Format draft deletion confirmation
export function printDraftDeleted(id: string): void {
  console.log(`Deleted draft: ${id}`);
}

// Format archive confirmation
export function printArchived(messageId: string): void {
  console.log(`Archived: ${messageId}`);
}

// Format mark read/unread confirmation
export function printMarked(messageId: string, read: boolean): void {
  console.log(`Marked ${messageId} as ${read ? 'read' : 'unread'}`);
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
