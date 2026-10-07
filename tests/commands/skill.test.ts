import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { addExamples } from '../../src/utils/command-tree';
import { generateSkill } from '../../src/commands/skill';

function buildFixtureProgram(): Command {
  const program = new Command('agentio').version('0.0.0-test');
  const gmail = program.command('gmail').description('Gmail operations');
  const list = gmail
    .command('list')
    .description('List messages')
    .option('--limit <n>', 'Max results', '10')
    .action(() => {});
  addExamples(
    list,
    `Examples:

  # list 10 most recent
  agentio gmail list --limit 10`,
  );
  return program;
}

describe('generateSkill', () => {
  it('emits frontmatter with the service name and description', () => {
    const out = generateSkill(buildFixtureProgram(), 'gmail');
    expect(out).toMatch(/^---\nname: agentio-gmail\ndescription: .+\n---\n/);
  });

  it('includes a heading per leaf command with the full path', () => {
    const out = generateSkill(buildFixtureProgram(), 'gmail');
    expect(out).toContain('## agentio gmail list');
  });

  it('renders the examples block verbatim', () => {
    const out = generateSkill(buildFixtureProgram(), 'gmail');
    expect(out).toContain('# list 10 most recent');
    expect(out).toContain('agentio gmail list --limit 10');
  });

  it('renders options under an Options: heading', () => {
    const out = generateSkill(buildFixtureProgram(), 'gmail');
    expect(out).toContain('Options:');
    expect(out).toContain('--limit <n>');
  });

  it('throws when the service has no commands', () => {
    expect(() => generateSkill(buildFixtureProgram(), 'nonexistent')).toThrow(
      /no commands found/i,
    );
  });

  it('skips an empty-array default and joins a non-empty one', () => {
    const program = new Command('agentio');
    const svc = program.command('gmail').description('Gmail operations');
    const collect = (value: string, previous: string[]) => [...previous, value];
    svc.command('pick').description('Pick').option('--opt <v>', 'Repeatable', collect, []).option('--tag <v>', 'Tagged', collect, ['a', 'b']).action(() => {});
    const out = generateSkill(program, 'gmail');
    expect(out).toContain('- `--opt <v>`: Repeatable\n');
    expect(out).not.toContain('(default: )');
    expect(out).toContain('- `--tag <v>`: Tagged (default: a, b)');
  });

  it('titles a plugin skill with its display name', () => {
    const program = new Command('agentio');
    program.command('chatgpt').description('x').command('ask').action(() => {});
    expect(generateSkill(program, 'chatgpt')).toContain('# ChatGPT via agentio');
  });

  it('falls back to the capitalised id when the service is not a plugin', () => {
    const program = new Command('agentio');
    program.command('daemon').description('x').command('start').action(() => {});
    expect(generateSkill(program, 'daemon')).toContain('# Daemon via agentio');
  });
});
