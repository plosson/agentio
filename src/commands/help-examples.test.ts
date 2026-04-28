import { describe, expect, it } from 'bun:test';
import { collectCommands } from '../utils/command-tree';
import { createProgram } from '../index-program';

// Leaf commands NOT YET migrated to addExamples. Drive this list to empty.
// Format: 'service subcommand' (no leading 'agentio ').
const EXEMPT_PENDING = new Set<string>([
  // Populated by Task 3 step 1 — every currently-visible leaf command
  // that does not yet have an Examples: block. Drive this list to empty as
  // each service is migrated to use addExamples().
  'discourse list',
  'discourse get',
  'discourse categories',
  'gcal calendars',
  'gcal events',
  'gcal get',
  'gcal create',
  'gcal update',
  'gcal delete',
  'gcal search',
  'gcal respond',
  'gcal freebusy',
  'gdrive list',
  'gdrive folders',
  'gdrive get',
  'gdrive search',
  'gdrive download',
  'gdrive put',
  'github install',
  'github uninstall',
  'gsheets list',
  'gsheets get',
  'gsheets update',
  'gsheets append',
  'gsheets clear',
  'gsheets format',
  'gsheets resize',
  'gsheets batch',
  'gsheets metadata',
  'gsheets create',
  'gsheets copy',
  'gsheets export',
  'gtasks lists list',
  'gtasks lists create',
  'gtasks lists delete',
  'gtasks list',
  'gtasks get',
  'gtasks add',
  'gtasks update',
  'gtasks done',
  'gtasks undo',
  'gtasks delete',
  'gtasks clear',
  'gtasks move',
  'slack send',
  'sql query',
  'whatsapp inbox pull',
  'whatsapp inbox get',
  'whatsapp inbox ack',
  'whatsapp inbox reply',
  'whatsapp inbox stats',
  'whatsapp outbox send',
  'whatsapp outbox status',
  'whatsapp outbox list',
  'whatsapp group list',
  'whatsapp group get',
  'whatsapp group create',
  'whatsapp group update',
  'whatsapp group add',
  'whatsapp group remove',
  'whatsapp group promote',
  'whatsapp group demote',
  'whatsapp group leave',
  'whatsapp group invite',
  'whatsapp group join',
  'config export',
  'config import',
  'config env set',
  'config env unset',
  'config clear',
  'mcp serve',
  'mcp install',
  'mcp teleport',
  'daemon install',
  'daemon start',
  'daemon stop',
  'daemon restart',
  'daemon status',
  'daemon logs',
  'daemon uninstall',
  'daemon teleport',
  'doctor',
  'server install',
  'server start',
  'server stop',
  'server restart',
  'server status',
  'server logs',
  'server tokens list',
  'server tokens revoke',
  'server tokens clear',
  'server uninstall',
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
