import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderDocs } from '../../src/commands/docs';
import { CliError } from '../../src/utils/errors';

function fixture(): Command {
  const program = new Command('agentio').version('9.9.9');
  const svc = program.command('svc').description('A service');
  svc
    .command('get')
    .description('Get one')
    .argument('<id>', 'Item id')
    .option('--limit <n>', 'Max results', '10')
    .option('--label <label>', 'Filter (repeatable)', (v: string, acc: string[]) => [...acc, v], [])
    .option('--empty <x>', 'Empty default', '')
    .option('--flag', 'A switch', false);
  svc.command('list').description('List all');
  program.command('status').description('Show status').option('--json', 'JSON');
  program.command('docs', { hidden: true }).description('Docs');
  return program;
}

describe('docs', () => {
  test('markdown is the default and prints the defaults Bun prints, empty arrays included', () => {
    const out = renderDocs(fixture(), {});
    expect(out).toBe(renderDocs(fixture(), { format: 'markdown' }));
    expect(out).toBe(
      [
        '# agentio CLI v9.9.9',
        '',
        '## agentio svc get <id>',
        'Get one',
        '--limit <n>: Max results (default: 10)',
        '--label <label>: Filter (repeatable) (default: )',
        '--empty <x>: Empty default',
        '--flag: A switch (default: false)',
        '',
        '## agentio svc list',
        'List all',
      ].join('\n'),
    );
  });

  test('json carries the same commands, with defaults as the text markdown shows', () => {
    const parsed = JSON.parse(renderDocs(fixture(), { format: 'json' }));
    expect(parsed.version).toBe('9.9.9');
    expect(parsed.commands.map((c: { command: string }) => c.command)).toEqual(['agentio svc get', 'agentio svc list']);
    expect(parsed.commands[0]).toEqual({
      command: 'agentio svc get',
      description: 'Get one',
      arguments: ['<id>'],
      options: [
        { flags: '--limit <n>', description: 'Max results', defaultValue: '10' },
        { flags: '--label <label>', description: 'Filter (repeatable)', defaultValue: '' },
        { flags: '--empty <x>', description: 'Empty default' },
        { flags: '--flag', description: 'A switch', defaultValue: 'false' },
      ],
    });
  });

  test('--service selects excluded commands too, and an empty name selects nothing', () => {
    expect(renderDocs(fixture(), { service: ['status'] })).toContain('## agentio status\nShow status\n--json: JSON');
    expect(renderDocs(fixture(), {})).not.toContain('agentio status');
    expect(renderDocs(fixture(), { service: [''] })).toBe('# agentio CLI v9.9.9');
    expect(JSON.parse(renderDocs(fixture(), { service: [''], format: 'json' })).commands).toEqual([]);
  });

  test('an unknown format is refused, not silently rendered as markdown', () => {
    for (const format of ['xml', 'JSON', ' json', '']) {
      let thrown: unknown;
      try {
        renderDocs(fixture(), { format });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect(thrown).toMatchObject({ code: 'INVALID_PARAMS', message: `Unknown format: ${format}`, suggestion: 'Use --format markdown or --format json' });
    }
  });
});

describe('docs through a pipe', () => {
  // Bun cut a console.log over 64 KiB short at an OS pipe once process.stdout
  // had been read, which @inquirer/core does on import: `agentio docs | …` got 65,536 bytes.
  // Bun.spawn's own stdout pipe never showed it, so a shell makes the pipe.
  let home: string;
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'agentio-docs-pipe-')); });
  afterAll(async () => { await rm(home, { recursive: true, force: true }); });

  async function sh(script: string): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(['sh', '-c', script], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, HOME: home, AGENTIO_HOME: home, AGENTIO_NO_AUTO_UPDATE: '1', AGENTIO_TOKEN: '' },
    });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  }

  for (const format of ['json', 'markdown']) {
    test(`--format ${format} piped to a slow reader is the same as written to a file`, async () => {
      const file = join(home, `docs.${format}`);
      const cli = `bun run src/index.ts docs --format ${format}`;
      const piped = await sh(`${cli} | (sleep 1; cat)`);
      const direct = await sh(`${cli} > '${file}' && cat '${file}'`);
      expect(piped.code).toBe(0);
      expect(direct.stdout.length).toBeGreaterThan(65536);
      expect(piped.stdout.length).toBe(direct.stdout.length);
      expect(piped.stdout).toBe(direct.stdout);
      if (format === 'json') expect(JSON.parse(piped.stdout).commands.length).toBeGreaterThan(100);
    });
  }
});
