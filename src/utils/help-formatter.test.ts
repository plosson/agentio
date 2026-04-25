import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { applyGroupedHelp, type CommandGroups } from './help-formatter';

describe('applyGroupedHelp', () => {
  test('renders groups with headers and ungrouped commands at the bottom', () => {
    const program = new Command('agentio');
    program.command('gmail').description('Gmail');
    program.command('schedule').description('Schedule');
    program.command('daemon').description('Daemon');
    program.command('orphan').description('Orphan');

    const groups: CommandGroups = {
      Services: ['gmail'],
      Automation: ['schedule', 'daemon'],
    };
    applyGroupedHelp(program, groups);

    const help = program.helpInformation();
    expect(help).toContain('Services:');
    expect(help).toContain('  gmail');
    expect(help).toContain('Automation:');
    expect(help).toContain('  schedule');
    expect(help).toContain('  daemon');
    expect(help.indexOf('Other:')).toBeGreaterThan(help.indexOf('Automation:'));
    expect(help).toContain('  orphan');
  });

  test('ignores hidden commands', () => {
    const program = new Command('agentio');
    program.command('visible').description('Visible');
    program.command('hidden-one', { hidden: true }).description('Hidden');
    applyGroupedHelp(program, { Services: ['visible'] });
    const help = program.helpInformation();
    expect(help).toContain('visible');
    expect(help).not.toContain('hidden-one');
  });
});
