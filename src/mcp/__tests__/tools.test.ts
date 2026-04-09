import { describe, test, expect } from 'bun:test';
import { Command } from 'commander';
import { collectMcpTools } from '../tools';
import { registerRssCommands } from '../../commands/rss';
import { registerGmailCommands } from '../../commands/gmail';
import { registerSlackCommands } from '../../commands/slack';
import { registerWhatsAppCommands } from '../../commands/whatsapp';

function buildProgram(...registers: ((p: Command) => void)[]): Command {
  const program = new Command();
  program.name('agentio');
  for (const reg of registers) {
    reg(program);
  }
  return program;
}

describe('collectMcpTools', () => {
  test('collects leaf commands for a simple service (rss)', () => {
    const program = buildProgram(registerRssCommands);
    const tools = collectMcpTools(program, 'rss');

    const names = tools.map((t) => t.name);
    expect(names).toContain('rss_articles');
    expect(names).toContain('rss_get');
    expect(names).toContain('rss_info');
    expect(names).toHaveLength(3);
  });

  test('excludes profile subcommands', () => {
    const program = buildProgram(registerGmailCommands);
    const tools = collectMcpTools(program, 'gmail');

    const names = tools.map((t) => t.name);
    // Should not contain profile-related tools
    expect(names.some((n) => n.includes('profile'))).toBe(false);
  });

  test('excludes --profile from options', () => {
    const program = buildProgram(registerGmailCommands);
    const tools = collectMcpTools(program, 'gmail');

    for (const tool of tools) {
      const optLongs = tool.options.map((o) => o.long);
      expect(optLongs).not.toContain('profile');
      expect(Object.keys(tool.inputSchema.properties)).not.toContain('profile');
    }
  });

  test('returns empty array for unknown service', () => {
    const program = buildProgram(registerRssCommands);
    const tools = collectMcpTools(program, 'nonexistent');
    expect(tools).toHaveLength(0);
  });

  test('marks required positional arguments as required in schema', () => {
    const program = buildProgram(registerRssCommands);
    const tools = collectMcpTools(program, 'rss');

    const getTool = tools.find((t) => t.name === 'rss_get')!;
    expect(getTool.inputSchema.required).toContain('url');
    expect(getTool.inputSchema.required).toContain('article_id');
  });

  test('does not mark options as required in schema', () => {
    const program = buildProgram(registerRssCommands);
    const tools = collectMcpTools(program, 'rss');

    const articlesTool = tools.find((t) => t.name === 'rss_articles')!;
    // --limit and --since should NOT be in required
    expect(articlesTool.inputSchema.required).not.toContain('limit');
    expect(articlesTool.inputSchema.required).not.toContain('since');
  });

  test('identifies boolean options correctly', () => {
    const program = buildProgram(registerGmailCommands);
    const tools = collectMcpTools(program, 'gmail');

    const sendTool = tools.find((t) => t.name === 'gmail_send')!;
    const htmlProp = sendTool.inputSchema.properties['html'];
    expect(htmlProp).toBeDefined();
    expect(htmlProp.type).toBe('boolean');
  });

  test('handles nested commands (whatsapp inbox/outbox/group)', () => {
    const program = buildProgram(registerWhatsAppCommands);
    const tools = collectMcpTools(program, 'whatsapp');

    const names = tools.map((t) => t.name);
    expect(names).toContain('whatsapp_inbox_pull');
    expect(names).toContain('whatsapp_inbox_get');
    expect(names).toContain('whatsapp_inbox_ack');
    expect(names).toContain('whatsapp_inbox_reply');
    expect(names).toContain('whatsapp_outbox_send');
    expect(names).toContain('whatsapp_group_list');
  });

  test('tool has correct commandPath', () => {
    const program = buildProgram(registerWhatsAppCommands);
    const tools = collectMcpTools(program, 'whatsapp');

    const pullTool = tools.find((t) => t.name === 'whatsapp_inbox_pull')!;
    expect(pullTool.commandPath).toEqual(['whatsapp', 'inbox', 'pull']);
  });

  test('tool inputSchema has valid JSON Schema structure', () => {
    const program = buildProgram(registerRssCommands);
    const tools = collectMcpTools(program, 'rss');

    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(typeof tool.inputSchema.properties).toBe('object');

      // All property values should have a type
      for (const [, prop] of Object.entries(tool.inputSchema.properties)) {
        expect(prop.type).toBeDefined();
        expect(['string', 'boolean']).toContain(prop.type);
      }
    }
  });

  test('collects tools from multiple services independently', () => {
    const program = buildProgram(registerRssCommands, registerSlackCommands);

    const rssTools = collectMcpTools(program, 'rss');
    const slackTools = collectMcpTools(program, 'slack');

    expect(rssTools.length).toBeGreaterThan(0);
    expect(slackTools.length).toBeGreaterThan(0);

    // No cross-contamination
    expect(rssTools.every((t) => t.name.startsWith('rss_'))).toBe(true);
    expect(slackTools.every((t) => t.name.startsWith('slack_'))).toBe(true);
  });
});
