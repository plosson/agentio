import { Command } from 'commander';
import { collectMcpTools } from '../../src/mcp/tools';
import { SERVICE_REGISTRATIONS } from '../../src/mcp/server';

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderMcpToolsHtml(slug: string): string {
  const register = SERVICE_REGISTRATIONS[slug];
  if (!register) {
    return '<p class="dim">Not yet exposed via MCP.</p>';
  }

  const program = new Command();
  program.name('agentio');
  register(program);
  const tools = collectMcpTools(program, slug);

  if (tools.length === 0) {
    return '<p class="dim">No MCP tools registered.</p>';
  }

  const items = tools.map((t) => `<li>
    <div class="cmd-name">${escape(t.name)}</div>
    ${t.description ? `<div class="cmd-desc">${escape(t.description)}</div>` : ''}
  </li>`).join('');

  return `<ul class="cmd-list">${items}</ul>`;
}
