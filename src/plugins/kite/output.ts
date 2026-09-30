import { writeJson } from '../../utils/output';
import type { KiteDocument, KiteSharing, KiteThread } from './types';

/** `--json` writes `data`; otherwise `text` prints for people. */
function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data, 2);
  else text();
}

function documentLines(doc: KiteDocument): void {
  console.log(`${doc.title} (${doc.type}, version ${doc.version})`);
  console.log(`  ID: ${doc.id}`);
  console.log(`  URL: ${doc.url}`);
  console.log(`  Updated: ${doc.updated}`);
}

export function printDocument(doc: KiteDocument, json?: boolean): void {
  emit(json, doc, () => documentLines(doc));
}

/** `get`: the content itself, or where it was written with `--out`. */
export function printFetchedDocument(doc: KiteDocument & ({ content: string } | { file: string }), json?: boolean): void {
  emit(json, doc, () => {
    documentLines(doc);
    if ('file' in doc) {
      console.log(`  Written to: ${doc.file}`);
      return;
    }
    console.log('---');
    console.log(doc.content);
  });
}

export function printDocumentList(docs: KiteDocument[], json?: boolean): void {
  emit(json, { documents: docs }, () => {
    if (docs.length === 0) {
      console.log('No documents');
      return;
    }
    console.log(`Documents (${docs.length})\n`);
    for (const doc of docs) {
      documentLines(doc);
      console.log('');
    }
  });
}

export function printDeleted(id: string, json?: boolean): void {
  emit(json, { id, deleted: true }, () => console.log(`Deleted ${id}`));
}

export function printSharing(sharing: KiteSharing & { notified?: boolean }, json?: boolean): void {
  emit(json, sharing, () => {
    console.log(`Sharing for ${sharing.id}`);
    console.log(`  Public: ${sharing.isPublic ? 'yes, anyone with the link' : 'no'}`);
    console.log(`  Expires: ${sharing.expiresAt ?? 'never'}`);
    const people = sharing.people.map((p) => (p.pending ? `${p.email} (not opened yet)` : p.email));
    console.log(`  People: ${people.length ? people.join(', ') : 'none'}`);
    console.log(`  Domains: ${sharing.domains.length ? sharing.domains.join(', ') : 'none'}`);
    if (sharing.notified !== undefined) {
      console.log(sharing.notified ? '  Newly shared; they were emailed.' : '  Already shared; nobody was emailed.');
    }
  });
}

function anchorText(thread: KiteThread): string {
  const anchor = thread.anchor as { snippet?: unknown; elementId?: unknown } | null;
  let where = 'on the whole document';
  if (anchor && typeof anchor.snippet === 'string') {
    const snippet = anchor.snippet.length > 60 ? `${anchor.snippet.slice(0, 57)}...` : anchor.snippet;
    where = `on "${snippet.replace(/\s+/g, ' ')}"`;
  } else if (anchor && typeof anchor.elementId === 'string') {
    where = `on element #${anchor.elementId}`;
  }
  if (thread.anchorLost) where += ' (passage no longer found)';
  else if (thread.anchorDrifted) where += ' (passage moved)';
  return where;
}

function threadLines(thread: KiteThread): void {
  console.log(`[${thread.id}] ${thread.status} ${anchorText(thread)}`);
  for (const c of thread.comments) {
    console.log(`  ${c.author ?? '(deleted user)'} at ${c.createdAt}:`);
    for (const line of c.body.split('\n')) console.log(`    ${line}`);
  }
}

export function printThreads(threads: KiteThread[], json?: boolean): void {
  emit(json, { threads }, () => {
    if (threads.length === 0) {
      console.log('No comments');
      return;
    }
    for (const thread of threads) {
      threadLines(thread);
      console.log('');
    }
  });
}

export function printThread(thread: KiteThread & { mentions?: unknown }, json?: boolean): void {
  emit(json, thread, () => threadLines(thread));
}

export function printReply(reply: { id: string; author: string | null; body: string; createdAt: string; mentions: unknown }, json?: boolean): void {
  emit(json, reply, () => console.log(`Replied (${reply.id}) at ${reply.createdAt}`));
}
