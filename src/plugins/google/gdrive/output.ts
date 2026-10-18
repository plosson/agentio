import type { GDriveFile, GDriveDownloadResult, GDriveUploadResult, GDrivePermission, GDriveShareResult, GDriveCopyResult } from './types';
import { formatBytes } from '../format';
import { textFieldValue, type TextField } from './recursive';

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

export function printGDriveFileList(files: GDriveFile[], title: string = 'Files', extra: TextField[] = []): void {
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
    const label = file.path ?? file.name;
    const name = isFolder ? `${label}/` : label;
    console.log(`${type} ${size}  ${date}  ${flags.padEnd(2)} ${name}`);
    const fields = extra.map((f) => `${f}=${textFieldValue(file, f)}`);
    console.log(`  ${[file.id, ...fields].join('  ')}`);
  }
}

export function printGDriveFile(file: GDriveFile): void {
  console.log(`ID: ${file.id}`);
  console.log(`Name: ${file.name}`);
  console.log(`Type: ${file.mimeType}`);
  if (file.size !== undefined) console.log(`Size: ${formatBytes(file.size)} (${file.size} bytes)`);
  console.log(`MD5: ${file.md5Checksum ?? '-'}`);
  if (file.shortcutDetails) console.log(`Shortcut to: ${file.shortcutDetails.targetId}${file.shortcutDetails.targetMimeType ? ` (${file.shortcutDetails.targetMimeType})` : ''}`);
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
