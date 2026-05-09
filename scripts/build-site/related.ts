import type { ParsedEntry } from './changelog';

const REPO_URL = 'https://github.com/plosson/agentio';

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderRelatedHtml(slug: string, allEntries: ParsedEntry[]): string {
  const matching = allEntries.filter((e) => e.scope === slug);
  if (matching.length === 0) {
    return '<p class="dim">No changelog entries reference this service yet.</p>';
  }
  const items = matching.slice(0, 20).map((e) => `<li>
    <span class="release-scope">${e.type}</span>
    ${escape(e.subject)}
    <a class="release-sha" href="${REPO_URL}/commit/${e.sha}">${e.sha}</a>
  </li>`).join('');
  return `<ul class="cmd-list">${items}</ul>`;
}
