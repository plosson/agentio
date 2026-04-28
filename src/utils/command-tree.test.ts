import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { addExamples, collectCommands, getExamples } from './command-tree';

describe('command-tree', () => {
  it('collectCommands walks nested subcommands and returns leaf commands', () => {
    const program = new Command('root');
    const svc = program.command('svc').description('a service');
    svc.command('do <thing>').description('do a thing').action(() => {});

    const commands = collectCommands(program, 'root');
    const paths = commands.map((c) => c.fullPath);

    expect(paths).toContain('root svc do');
  });

  it('addExamples stores the text in a side-table accessible via getExamples', () => {
    const cmd = new Command('demo').action(() => {});
    addExamples(
      cmd,
      `Examples:

  # demo it
  agentio demo`,
    );

    const text = getExamples(cmd);
    expect(text).toContain('# demo it');
    expect(text).toContain('agentio demo');
  });

  it('addExamples also registers the text with Commander so it appears in helpInformation', () => {
    const cmd = new Command('demo').action(() => {});
    addExamples(cmd, 'Examples:\n\n  # x\n  agentio demo');

    const help = cmd.helpInformation();
    expect(help).toContain('Examples:');
    expect(help).toContain('agentio demo');
  });

  it('getExamples returns undefined when no examples were registered', () => {
    const cmd = new Command('demo').action(() => {});
    expect(getExamples(cmd)).toBeUndefined();
  });
});
