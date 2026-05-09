import { Command } from 'commander';
import { collectCommands, type CommandInfo } from '../../src/utils/command-tree';
import { registerAllCommands } from './register-all';

let cachedCommands: CommandInfo[] | null = null;

function getCommands(): CommandInfo[] {
  if (cachedCommands) return cachedCommands;
  const program = new Command();
  program.name('agentio');
  registerAllCommands(program);
  cachedCommands = collectCommands(program, 'agentio');
  return cachedCommands;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderCommandsHtml(slug: string): string {
  const all = getCommands();
  const cmds = all.filter((cmd) => {
    const parts = cmd.fullPath.split(' ');
    if (parts[1] !== slug) return false;
    if (cmd.fullPath.includes(' profile ')) return false;
    return true;
  });

  if (cmds.length === 0) {
    return '<p class="dim">No commands registered for this service.</p>';
  }

  const items = cmds.map((cmd) => {
    const fullCommand = cmd.arguments.length
      ? `${cmd.fullPath} ${cmd.arguments.join(' ')}`
      : cmd.fullPath;
    const optsHtml = cmd.options.length
      ? `<div class="cmd-opts">${cmd.options.map((o) => `<code>${escape(o.flags)}</code>`).join(' ')}</div>`
      : '';
    return `<li>
      <div class="cmd-name">${escape(fullCommand)}</div>
      ${cmd.description ? `<div class="cmd-desc">${escape(cmd.description)}</div>` : ''}
      ${optsHtml}
    </li>`;
  }).join('');

  return `<ul class="cmd-list">${items}</ul>`;
}
