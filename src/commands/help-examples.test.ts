import { describe, expect, it } from 'bun:test';
import { collectCommands } from '../utils/command-tree';
import { createProgram } from '../index-program';

// Leaf commands NOT YET migrated to addExamples. Drive this list to empty.
// Format: 'service subcommand' (no leading 'agentio ').
const EXEMPT_PENDING = new Set<string>([
  // Populated by Task 3 step 1 — every currently-visible leaf command
  // that does not yet have an Examples: block. Drive this list to empty as
  // each service is migrated to use addExamples().
  'config export',
  'config import',
  'config env set',
  'config env unset',
  'config clear',
  'doctor',
  'setup',
  'status',
  'update',
]);

describe('help examples gate', () => {
  it('every non-exempt leaf command has an Examples: block', () => {
    const program = createProgram();
    const all = collectCommands(program, 'agentio');

    const offenders: string[] = [];
    for (const cmd of all) {
      const key = cmd.fullPath.replace(/^agentio /, '');
      if (cmd.fullPath.includes(' profile ')) continue;
      if (EXEMPT_PENDING.has(key)) continue;
      if (!cmd.examples) {
        offenders.push(cmd.fullPath);
        continue;
      }
      const firstNonBlank = cmd.examples.split('\n').find((l) => l.trim().length > 0);
      if (firstNonBlank?.trim() !== 'Examples:') {
        offenders.push(`${cmd.fullPath} (block does not start with "Examples:")`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('EXEMPT_PENDING contains no stale entries', () => {
    const program = createProgram();
    const all = collectCommands(program, 'agentio');
    const knownPaths = new Set(all.map((c) => c.fullPath.replace(/^agentio /, '')));

    const stale: string[] = [];
    for (const exempt of EXEMPT_PENDING) {
      if (!knownPaths.has(exempt)) stale.push(exempt);
    }

    expect(stale).toEqual([]);
  });
});
