import { writeJson } from '../../utils/output';
import type { KiteDocument, KiteLibrary, KiteReply, KiteSharing, KiteThread, KiteWorkspace } from './types';

/** `--json` writes `data`; otherwise `text` prints for people. */
function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data, 2);
  else text();
}

function documentLines(doc: KiteDocument): void {
  console.log(`${doc.title} (${doc.type}, version ${doc.version})`);
  if (doc.description) console.log(`  ${doc.description}`);
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

/** How current a summary is, said the way a reader needs it. */
function summaryState(doc: KiteDocument): string {
  if (doc.summary === null || doc.summaryVersion === null) return 'missing';
  const behind = doc.version - doc.summaryVersion;
  if (behind <= 0) return 'current';
  return `written for version ${doc.summaryVersion}, ${behind} version${behind === 1 ? '' : 's'} behind`;
}

function workspaceLines(workspace: KiteWorkspace): void {
  console.log(`${workspace.name} (${workspace.count} document${workspace.count === 1 ? '' : 's'})`);
  console.log(`  ID: ${workspace.id}`);
  console.log(`  ${workspace.description}`);
}

export function printWorkspaces(workspaces: KiteWorkspace[], json?: boolean): void {
  emit(json, { workspaces }, () => {
    for (const workspace of workspaces) {
      workspaceLines(workspace);
      console.log('');
    }
  });
}

export function printWorkspace(workspace: KiteWorkspace, json?: boolean): void {
  emit(json, workspace, () => workspaceLines(workspace));
}

export function printMoved(moved: { id: string; workspace: KiteWorkspace }, json?: boolean): void {
  emit(json, { id: moved.id, workspace: moved.workspace.id }, () => console.log(`Moved ${moved.id} to ${moved.workspace.name}`));
}

export function printLibrary(library: KiteLibrary, json?: boolean): void {
  emit(json, library, () => {
    console.log('Workspaces\n');
    for (const workspace of library.workspaces) {
      workspaceLines(workspace);
      console.log('');
    }
    const names = new Map(library.workspaces.map((w) => [w.id, w.name]));
    console.log(`Documents (${library.documents.length})\n`);
    for (const doc of library.documents) {
      console.log(`${doc.title} (${doc.type}, version ${doc.version})`);
      console.log(`  ID: ${doc.id}`);
      console.log(`  Workspace: ${names.get(doc.workspace) ?? doc.workspace}`);
      console.log(`  Description: ${doc.description ?? '(missing)'}`);
      console.log(`  Summary (${summaryState(doc)}):`);
      for (const line of (doc.summary ?? '(missing)').split('\n')) console.log(`    ${line}`);
      console.log('');
    }
    console.log(library.instructions);
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
    const people = sharing.people.map((p) => (p.pending ? `${p.email} (no Kite account yet)` : p.email));
    console.log(`  People: ${people.length ? people.join(', ') : 'none'}`);
    console.log(`  Domains: ${sharing.domains.length ? sharing.domains.join(', ') : 'none'}`);
    if (sharing.notified) console.log('  They were emailed a link.');
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

export function printReply(reply: KiteReply, json?: boolean): void {
  emit(json, reply, () => console.log(`Replied (${reply.id}) at ${reply.createdAt}`));
}
