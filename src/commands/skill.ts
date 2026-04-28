import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { collectCommands, type CommandInfo } from '../utils/command-tree';
import { CliError, handleError } from '../utils/errors';

const SERVICE_DESCRIPTIONS: Record<string, string> = {
  gmail: 'Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export.',
  gdocs: 'Use when interacting with Google Docs via the agentio CLI - list, read, create.',
  gdrive: 'Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation.',
  telegram: 'Use when interacting with Telegram via the agentio CLI - send messages, manage inbox/outbox via the daemon.',
  gchat: 'Use when interacting with Google Chat via the agentio CLI - send messages, list spaces, read history.',
  gcal: 'Use when interacting with Google Calendar via the agentio CLI.',
  gsheets: 'Use when interacting with Google Sheets via the agentio CLI.',
  gtasks: 'Use when interacting with Google Tasks via the agentio CLI.',
  github: 'Use when interacting with GitHub via the agentio CLI.',
  jira: 'Use when interacting with JIRA via the agentio CLI - search issues, comment, transition.',
  slack: 'Use when sending Slack messages via the agentio CLI.',
  rss: 'Use when reading RSS feeds via the agentio CLI.',
  discourse: 'Use when interacting with Discourse forums via the agentio CLI.',
  sql: 'Use when running SQL queries via the agentio CLI.',
  whatsapp: 'Use when interacting with WhatsApp via the agentio CLI - send/receive, group management. Requires daemon.',
  daemon: 'Use to manage the agentio daemon (real-time messaging connections + scheduler).',
  schedule: 'Use to manage agentio scheduled .run.md prompts in watched folders.',
};

function formatOption(opt: { flags: string; description: string; defaultValue?: string }): string {
  let line = `- \`${opt.flags}\``;
  if (opt.description) {
    line += `: ${opt.description}`;
  }
  if (opt.defaultValue !== undefined && opt.defaultValue !== '') {
    line += ` (default: ${opt.defaultValue})`;
  }
  return line;
}

function renderCommand(cmd: CommandInfo): string {
  const lines: string[] = [];
  let header = `## ${cmd.fullPath}`;
  if (cmd.arguments.length > 0) {
    header += ` ${cmd.arguments.join(' ')}`;
  }
  lines.push(header);
  lines.push('');

  if (cmd.description) {
    lines.push(cmd.description);
    lines.push('');
  }

  if (cmd.options.length > 0) {
    lines.push('Options:');
    lines.push('');
    for (const opt of cmd.options) {
      lines.push(formatOption(opt));
    }
    lines.push('');
  }

  if (cmd.examples) {
    lines.push('```');
    lines.push(cmd.examples.trim());
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

export function generateSkill(program: Command, service: string): string {
  const description = SERVICE_DESCRIPTIONS[service]
    ?? `Use when interacting with ${service} via the agentio CLI.`;

  const all = collectCommands(program, 'agentio');
  const scoped = all.filter((cmd) => {
    if (cmd.fullPath.includes(' profile ')) return false;
    const parts = cmd.fullPath.split(' ');
    return parts[1] === service;
  });

  if (scoped.length === 0) {
    throw new CliError('NOT_FOUND', `no commands found for service "${service}"`);
  }

  const out: string[] = [];
  out.push('---');
  out.push(`name: agentio-${service}`);
  out.push(`description: ${description}`);
  out.push('---');
  out.push('');
  out.push(`# ${service.charAt(0).toUpperCase() + service.slice(1)} via agentio`);
  out.push('');
  out.push(`Auto-generated from \`agentio skill ${service}\`. Do not edit by hand.`);
  out.push('');

  for (const cmd of scoped) {
    out.push(renderCommand(cmd));
  }

  return out.join('\n').trimEnd() + '\n';
}

function listServices(program: Command): string[] {
  const all = collectCommands(program, 'agentio');
  const services = new Set<string>();
  for (const cmd of all) {
    if (cmd.fullPath.includes(' profile ')) continue;
    const parts = cmd.fullPath.split(' ');
    if (parts[1]) services.add(parts[1]);
  }
  return Array.from(services).sort();
}

function skillFilePath(service: string): string {
  return path.join('claude', 'skills', `agentio-${service}`, 'SKILL.md');
}

export function registerSkillCommand(program: Command): void {
  program
    .command('skill', { hidden: true })
    .description('Emit auto-generated SKILL.md content for an agentio service')
    .argument('[service]', 'Service name (e.g. gmail). Omit with --all or --list.')
    .option('--all', 'Write SKILL.md for every service in claude/skills/')
    .option('--list', 'List services with registered commands')
    .action((service, options) => {
      try {
        if (options.list) {
          for (const s of listServices(program)) {
            console.log(s);
          }
          return;
        }

        if (options.all) {
          for (const s of listServices(program)) {
            const content = generateSkill(program, s);
            const file = skillFilePath(s);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content);
            console.error(`wrote ${file}`);
          }
          return;
        }

        if (!service) {
          throw new CliError('INVALID_PARAMS', 'specify a service, --all, or --list');
        }

        console.log(generateSkill(program, service));
      } catch (error) {
        handleError(error);
      }
    });
}
