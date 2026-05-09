import type { ReleaseGroups, ParsedEntry } from './changelog';
import type { VersionTag } from './git';

const REPO_URL = 'https://github.com/plosson/agentio';

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function entryLi(e: ParsedEntry): string {
  const scope = e.scope
    ? `<span class="release-scope">${escape(e.scope)}</span>`
    : '';
  return `<li id="${e.sha}-${escape(e.scope || 'all')}-${e.type}">
    ${scope}${escape(e.subject)}
    <a class="release-sha" href="${REPO_URL}/commit/${e.sha}">${e.sha}</a>
  </li>`;
}

function group(label: string, entries: ParsedEntry[]): string {
  if (entries.length === 0) return '';
  return `<div class="release-group">
    <h3>${label}</h3>
    <ul class="release-list">${entries.map(entryLi).join('')}</ul>
  </div>`;
}

export function renderRelease(tag: VersionTag, groups: ReleaseGroups): string {
  const date = new Date(tag.date).toISOString().slice(0, 10);
  const internal = groups.internal.length > 0
    ? `<details class="release-group">
        <summary><h3 style="display:inline">Internal changes</h3></summary>
        <ul class="release-list">${groups.internal.map(entryLi).join('')}</ul>
      </details>`
    : '';
  return `<article class="release" id="${escape(tag.name)}">
    <header class="release-head">
      <span class="release-version">${escape(tag.name)}</span>
      <span class="release-date">${date}</span>
    </header>
    ${group('Features', groups.features)}
    ${group('Fixes', groups.fixes)}
    ${internal}
  </article>`;
}
