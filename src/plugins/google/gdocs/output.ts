import type { GDocsDocument, GDocsCreateResult, GDocsBatchResult, GDocsTab } from './types';
export { raw } from '../format';

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

export function printGDocsTabs(tabs: GDocsTab[]): void {
  if (tabs.length === 0) {
    console.log('No tabs found (document has a single untitled tab)');
    return;
  }

  console.log(`Tabs (${tabs.length})\n`);

  for (const tab of tabs) {
    console.log(`${'  '.repeat(tab.depth)}${tab.id}\t${tab.title}`);
  }
}

export function printGDocsBatchResult(result: GDocsBatchResult): void {
  console.error(`Batch update applied to ${result.documentId} (${result.replies.length} replies)`);
  console.log(JSON.stringify({ documentId: result.documentId, replies: result.replies }, null, 2));
}
