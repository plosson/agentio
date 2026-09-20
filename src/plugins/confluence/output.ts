import type { ConfluenceSpace, ConfluencePage, ConfluencePageDetail, ConfluenceComment, ConfluenceSearchResult, ConfluencePageCreateResult, ConfluencePageUpdateResult, ConfluenceCommentResult } from './types';

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
