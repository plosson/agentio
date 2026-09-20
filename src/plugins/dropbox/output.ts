import type { DropboxAccount, DropboxDownloadResult, DropboxEntry, DropboxLink, DropboxUploadResult } from './types';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Dropbox specific formatters
export function printDropboxEntryList(entries: DropboxEntry[], title: string = 'Entries'): void {
  if (entries.length === 0) {
    console.log('No entries found');
    return;
  }

  console.log(`${title} (${entries.length})\n`);

  for (const entry of entries) {
    const type = entry.type.padEnd(6);
    const size = entry.size !== undefined ? formatBytes(entry.size).padStart(9) : '        -';
    const date = entry.modified ? entry.modified.slice(0, 10) : '          ';
    const path = entry.type === 'folder' ? `${entry.path}/` : entry.path;
    console.log(`${type} ${size}  ${date}  ${path}`);
  }
}

export function printDropboxEntry(entry: DropboxEntry): void {
  console.log(`Path: ${entry.path}`);
  console.log(`Name: ${entry.name}`);
  console.log(`Type: ${entry.type}`);
  if (entry.id) console.log(`ID: ${entry.id}`);
  if (entry.size !== undefined) console.log(`Size: ${formatBytes(entry.size)}`);
  if (entry.modified) console.log(`Modified: ${entry.modified}`);
  if (entry.rev) console.log(`Rev: ${entry.rev}`);
  if (entry.contentHash) console.log(`Content hash: ${entry.contentHash}`);
}

export function printDropboxDownloaded(result: DropboxDownloadResult): void {
  console.log(`Downloaded: ${result.path}`);
  console.log(`  Path: ${result.outputPath}`);
  console.log(`  Size: ${formatBytes(result.size)}`);
  if (result.kind === 'folder') console.log(`  Format: zip archive`);
}

export function printDropboxUploaded(result: DropboxUploadResult): void {
  console.log(`Uploaded: ${result.path}`);
  console.log(`  Size: ${formatBytes(result.size)}`);
  if (result.id) console.log(`  ID: ${result.id}`);
  if (result.rev) console.log(`  Rev: ${result.rev}`);
}

export function printDropboxLink(link: DropboxLink): void {
  console.log(link.url);
  console.log(`  Path: ${link.path}`);
  console.log(link.kind === 'temporary' ? '  Expires: in 4 hours' : '  Expires: never');
}

export function printDropboxAccount(account: DropboxAccount): void {
  console.log(`Account: ${account.name}`);
  console.log(`  Email: ${account.email}${account.emailVerified ? '' : ' (unverified)'}`);
  console.log(`  Type: ${account.accountType}`);
  if (account.country) console.log(`  Country: ${account.country}`);
  console.log(`  ID: ${account.accountId}`);
}
