import type { GScriptProject, GScriptListItem, GScriptFile, GScriptPullResult, GScriptPushResult } from './types';

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
