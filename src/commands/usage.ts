import { Command } from 'commander';
import { CliError, handleError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';
import { addJsonOption, isJsonMode, printJson } from '../utils/output';
import { DAY_MS, queryUsage, RETENTION_DAYS, USAGE_GROUPS, type UsageGroup, type UsageRow } from '../usage/store';

const DEFAULT_SINCE = '7d';
const DEFAULT_BY: UsageGroup = 'command';

/** `--since 30d`: whole days, 1 to the retention period. */
export function parseSince(value: string): number {
  const match = /^(\d{1,2})d$/.exec(value);
  const days = match ? Number(match[1]) : NaN;
  if (!(days >= 1 && days <= RETENTION_DAYS)) {
    throw new CliError('INVALID_PARAMS', `Invalid --since: ${value}`, `Use a number of days from 1 to ${RETENTION_DAYS}, such as 30d`);
  }
  return days * DAY_MS;
}

export function parseBy(value: string): UsageGroup {
  if (!(USAGE_GROUPS as readonly string[]).includes(value)) {
    throw new CliError('INVALID_PARAMS', `Invalid --by: ${value}`, `Use one of: ${USAGE_GROUPS.join(', ')}`);
  }
  return value as UsageGroup;
}

/** The failure rate; a few failures among many uses read `<1%`, not a reassuring 0%. */
const percent = (r: UsageRow) => {
  const rounded = Math.round((r.failures / r.count) * 100);
  return r.failures > 0 && rounded === 0 ? '<1%' : `${rounded}%`;
};
const minute = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
// Group names come from the store; keep each row on one line whatever they hold.
const oneLine = (s: string) => s.replace(/[\r\n\t]/g, ' ');

export function formatUsage(rows: UsageRow[], by: UsageGroup): string {
  const header = `${'USES'.padStart(6)}  ${'FAILED'.padStart(6)}  ${'LAST SEEN (UTC)'.padEnd(16)}  ${by.toUpperCase()}`;
  const lines = rows.map((r) => `${String(r.count).padStart(6)}  ${percent(r).padStart(6)}  ${minute(r.lastSeen).padEnd(16)}  ${oneLine(r.group)}`);
  return [header, ...lines].join('\n');
}

export function registerUsageCommand(program: Command): void {
  addExamples(
    addJsonOption(
      program
        .command('usage')
        .description("How often each machine, key, profile and command used this vault's credentials")
        .option('--by <group>', `Group by: ${USAGE_GROUPS.join(', ')}`, DEFAULT_BY)
        .option('--since <days>', `Time window, such as 30d (at most ${RETENTION_DAYS}d)`, DEFAULT_SINCE)
        .action(async (opts: { by: string; since: string }) => {
          try {
            const by = parseBy(opts.by);
            const rows = await queryUsage({ by, since: parseSince(opts.since) });
            if (isJsonMode()) {
              printJson({ by, since: opts.since, rows });
              return;
            }
            console.log(rows.length === 0 ? 'No usage recorded yet' : formatUsage(rows, by));
          } catch (error) {
            handleError(error);
          }
        }),
    ),
    `Examples:

  # the last 7 days, by command
  agentio usage

  # which machines used the vault this month
  agentio usage --by machine --since 30d

  # per-profile figures for a script
  agentio usage --by profile --json`,
  );
}
