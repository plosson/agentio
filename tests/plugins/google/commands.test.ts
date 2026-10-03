import { describe, expect, test } from 'bun:test';
import { createProgram } from '../../../src/cli';
import { renderDocs } from '../../../src/commands/docs';
import { parseServiceList } from '../../../src/plugins/google/commands';

describe('parseServiceList', () => {
  test('trims, drops empty parts, and keeps duplicates for the flow to fold', () => {
    expect(parseServiceList(' gmail, gmail ,gcal,')).toEqual(['gmail', 'gmail', 'gcal']);
  });

  test('an empty value is an empty list, which the flow refuses', () => {
    expect(parseServiceList('')).toEqual([]);
    expect(parseServiceList(' , ')).toEqual([]);
  });
});

describe('the google command', () => {
  test('exists, with profile add and its options', () => {
    const google = createProgram().commands.find((c) => c.name() === 'google');
    const add = google?.commands.find((c) => c.name() === 'profile')?.commands.find((c) => c.name() === 'add');
    expect(add?.options.map((o) => o.long)).toEqual(['--services', '--profile', '--read-only', '--force']);
  });

  test('is hidden from help and from the docs agents read', () => {
    const program = createProgram();
    expect(program.helpInformation()).not.toMatch(/^\s+google\b/m);
    expect(renderDocs(program, {})).not.toContain('agentio google');
    expect(renderDocs(program, { format: 'json' })).not.toContain('agentio google');
  });
});
