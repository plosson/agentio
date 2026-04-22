# agentio schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agentio schedule` subcommands to install, list, run, and reconcile locally-scheduled Claude Code prompts on macOS via `launchd`. `.run.md` files (with YAML frontmatter) are the source of truth; launchd plists are derived state.

**Architecture:**
- Per-folder `.run.md` files under `<folder>/` contain frontmatter (schedule config) + prompt body.
- `~/Library/LaunchAgents/me.agentio.schedule.<folder-hash>-<id>.plist` is generated from each `.run.md` file. `ProgramArguments` re-invokes `agentio schedule run <id> --folder <abs-folder> --from-launchd` under a login shell.
- Runtime state (sessionId, lastRunAt) lives in `<folder>/.agentio/state.json`. Per-run logs in `<folder>/.agentio/runs/<id>/<ISO>.log`.
- Pure builders (plist dict, schedule calculator, parsers) are separated from impure wrappers (launchctl, file I/O, child-process spawn) so the builders can be unit-tested directly.

**Tech Stack:** TypeScript, Bun, commander, `@inquirer/prompts` (already in deps), `gray-matter` (new dep), `plist` package (new dep) for plist XML generation, `bun:test` for tests.

**Spec:** `docs/plans/schedule.md` (read this first for full context).

---

## File Structure

```
src/types/schedule.ts                          # all schedule-related types
src/services/schedule/
  frontmatter.ts                               # gray-matter wrapper; parse + merge + serialize
  duration.ts                                  # parse "30m" / "1h30m" -> minutes
  weekdays.ts                                  # parse "mon,wed" / "1,3,5" -> number[]
  folder-hash.ts                               # djb2 hex hash of an absolute path
  schedule-calculator.ts                       # next N run times for a schedule
  state.ts                                     # .agentio/state.json read/write
  runs.ts                                      # enumerate .agentio/runs/<id>/ entries
  plist-builder.ts                             # pure: schedule -> plist dict
  launchd.ts                                   # impure: install/uninstall via launchctl, enumerate plists
  claude-binary.ts                             # locate claude binary + login-shell env
  runner.ts                                    # spawn claude (or command), stream stdout, write log
  walker.ts                                    # walk folder subtree for *.run.md files
src/commands/schedule.ts                       # registerScheduleCommands() — all subcommands + flags
claude/skills/agentio-schedule/SKILL.md        # skill doc following existing convention
```

Tests live next to the source file as `*.test.ts`, matching agentio's existing convention (`src/commands/teleport.test.ts`).

---

## Task 1: Add dependencies and type definitions

**Files:**
- Modify: `package.json`
- Create: `src/types/schedule.ts`

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/plosson/devel/projects/personal/agentio
bun add gray-matter plist
bun add -d @types/plist
```

Expected: `package.json` updated, `bun.lockb` regenerated, no errors.

- [ ] **Step 2: Create `src/types/schedule.ts`**

```typescript
export type ScheduleType = 'manual' | 'daily' | 'weekly' | 'monthly' | 'interval';

export interface Schedule {
  type: ScheduleType;
  hour?: number;        // 0-23 (daily/weekly/monthly)
  minute?: number;      // 0-59 (daily/weekly/monthly)
  weekdays?: number[];  // 1=Mon..7=Sun (weekly)
  day?: number;         // 1-31 (monthly)
  intervalMinutes?: number; // interval
}

export type Model = 'opus' | 'sonnet' | 'haiku';
export type PermissionMode = 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits';
export type SessionMode = 'new' | 'resume' | 'fork';

export interface FrontmatterConfig {
  schedule: Schedule;
  model: Model;
  permissionMode: PermissionMode;
  sessionMode: SessionMode;
  enabled: boolean;
  command?: string; // optional command override
}

export interface ScheduleState {
  sessionId?: string;
  lastRunAt?: string;    // ISO
  lastExitCode?: number;
}

export type StateFile = Record<string, ScheduleState>;

/** Parsed .run.md file. */
export interface ScheduleFile {
  config: FrontmatterConfig;
  body: string;
  /** absolute path to the .run.md file on disk */
  filePath: string;
  /** id derived from basename (without ".run.md") */
  id: string;
}

export const DEFAULT_MODEL: Model = 'sonnet';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';
export const DEFAULT_SESSION_MODE: SessionMode = 'new';
```

- [ ] **Step 3: Type-check passes**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb src/types/schedule.ts
git commit -m "feat(schedule): add dependencies and type definitions"
```

---

## Task 2: Frontmatter parsing, merging, and serialization

**Files:**
- Create: `src/services/schedule/frontmatter.ts`
- Test: `src/services/schedule/frontmatter.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/schedule/frontmatter.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { parseFrontmatter, serializeFrontmatter, mergeConfig } from './frontmatter';
import type { FrontmatterConfig } from '../../types/schedule';

describe('parseFrontmatter', () => {
  test('parses a complete frontmatter block', () => {
    const input = `---
schedule:
  type: daily
  hour: 21
  minute: 0
model: sonnet
permissionMode: bypassPermissions
sessionMode: new
enabled: true
---

Run the daily report.
`;
    const result = parseFrontmatter(input);
    expect(result.config).toEqual({
      schedule: { type: 'daily', hour: 21, minute: 0 },
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      sessionMode: 'new',
      enabled: true,
    });
    expect(result.body.trim()).toBe('Run the daily report.');
  });

  test('returns partial config when frontmatter is incomplete', () => {
    const input = `---
schedule:
  type: daily
---

Body.
`;
    const result = parseFrontmatter(input);
    expect(result.config).toEqual({
      schedule: { type: 'daily' },
    } as unknown as FrontmatterConfig);
    expect(result.body.trim()).toBe('Body.');
  });

  test('returns empty config when no frontmatter is present', () => {
    const input = 'Just a body.';
    const result = parseFrontmatter(input);
    expect(result.config).toEqual({} as unknown as FrontmatterConfig);
    expect(result.body.trim()).toBe('Just a body.');
  });
});

describe('mergeConfig', () => {
  test('override wins over base; defaults fill missing optional fields', () => {
    const base: Partial<FrontmatterConfig> = {
      schedule: { type: 'daily', hour: 8, minute: 0 },
      model: 'opus',
    };
    const override: Partial<FrontmatterConfig> = {
      schedule: { type: 'daily', hour: 21, minute: 30 },
    };
    const merged = mergeConfig(base, override);
    expect(merged.schedule).toEqual({ type: 'daily', hour: 21, minute: 30 });
    expect(merged.model).toBe('opus');
    expect(merged.permissionMode).toBe('bypassPermissions');
    expect(merged.sessionMode).toBe('new');
    expect(merged.enabled).toBe(true);
  });
});

describe('serializeFrontmatter', () => {
  test('round-trips a config', () => {
    const config: FrontmatterConfig = {
      schedule: { type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] },
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      sessionMode: 'new',
      enabled: true,
    };
    const body = 'Weekly standup summary.';
    const serialized = serializeFrontmatter(config, body);
    const reparsed = parseFrontmatter(serialized);
    expect(reparsed.config).toEqual(config);
    expect(reparsed.body.trim()).toBe(body);
  });

  test('omits command when undefined', () => {
    const config: FrontmatterConfig = {
      schedule: { type: 'manual' },
      model: 'sonnet',
      permissionMode: 'default',
      sessionMode: 'new',
      enabled: true,
    };
    const serialized = serializeFrontmatter(config, 'x');
    expect(serialized).not.toContain('command');
  });
});
```

- [ ] **Step 2: Run tests — they should fail (module missing)**

Run: `bun test src/services/schedule/frontmatter.test.ts`
Expected: fails with module-not-found error.

- [ ] **Step 3: Implement `frontmatter.ts`**

```typescript
import matter from 'gray-matter';
import type { FrontmatterConfig } from '../../types/schedule';
import {
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_SESSION_MODE,
} from '../../types/schedule';

export interface ParsedFrontmatter {
  config: Partial<FrontmatterConfig>;
  body: string;
}

/** Parse a raw .run.md string into {config, body}. Does not validate. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const parsed = matter(raw);
  const data = (parsed.data ?? {}) as Partial<FrontmatterConfig>;
  return { config: data, body: parsed.content };
}

/**
 * Merge two partial configs (override wins), then fill in defaults for optional
 * fields. The schedule object is replaced wholesale (not deep-merged) because
 * changing the schedule type may invalidate previous keys.
 */
export function mergeConfig(
  base: Partial<FrontmatterConfig>,
  override: Partial<FrontmatterConfig>
): FrontmatterConfig {
  const schedule = override.schedule ?? base.schedule;
  if (!schedule) {
    throw new Error('mergeConfig: schedule is required on base or override');
  }
  return {
    schedule,
    model: override.model ?? base.model ?? DEFAULT_MODEL,
    permissionMode: override.permissionMode ?? base.permissionMode ?? DEFAULT_PERMISSION_MODE,
    sessionMode: override.sessionMode ?? base.sessionMode ?? DEFAULT_SESSION_MODE,
    enabled: override.enabled ?? base.enabled ?? true,
    ...(override.command !== undefined
      ? { command: override.command }
      : base.command !== undefined
      ? { command: base.command }
      : {}),
  };
}

/** Serialize a complete config + body back to a .run.md string. */
export function serializeFrontmatter(config: FrontmatterConfig, body: string): string {
  const data: Record<string, unknown> = {
    schedule: config.schedule,
    model: config.model,
    permissionMode: config.permissionMode,
    sessionMode: config.sessionMode,
    enabled: config.enabled,
  };
  if (config.command !== undefined) {
    data.command = config.command;
  }
  return matter.stringify(body, data);
}
```

- [ ] **Step 4: Run tests — they should pass**

Run: `bun test src/services/schedule/frontmatter.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/schedule/frontmatter.ts src/services/schedule/frontmatter.test.ts
git commit -m "feat(schedule): add frontmatter parser/serializer"
```

---

## Task 3: Duration and weekdays parsers

**Files:**
- Create: `src/services/schedule/duration.ts`
- Create: `src/services/schedule/weekdays.ts`
- Test: `src/services/schedule/duration.test.ts`
- Test: `src/services/schedule/weekdays.test.ts`

- [ ] **Step 1: Write failing duration tests**

Create `src/services/schedule/duration.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { parseDuration } from './duration';

describe('parseDuration', () => {
  test('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30);
    expect(parseDuration('1m')).toBe(1);
  });
  test('parses hours', () => {
    expect(parseDuration('2h')).toBe(120);
  });
  test('parses compound', () => {
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('2h5m')).toBe(125);
  });
  test('rejects invalid input', () => {
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('30')).toThrow();
    expect(() => parseDuration('0m')).toThrow();
    expect(() => parseDuration('0h0m')).toThrow();
  });
});
```

- [ ] **Step 2: Run test — should fail (missing module)**

Run: `bun test src/services/schedule/duration.test.ts`
Expected: module-not-found failure.

- [ ] **Step 3: Implement `duration.ts`**

```typescript
/**
 * Parses a human-readable duration string like "30m", "2h", "1h30m".
 * Returns minutes. Throws on invalid input or zero total.
 */
export function parseDuration(input: string): number {
  if (!input) throw new Error('Duration is empty');
  const match = input.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(`Invalid duration: "${input}" (expected e.g. "30m", "2h", "1h30m")`);
  }
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  const total = hours * 60 + mins;
  if (total <= 0) throw new Error(`Duration must be > 0: "${input}"`);
  return total;
}
```

- [ ] **Step 4: Run — should pass**

Run: `bun test src/services/schedule/duration.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Write failing weekdays tests**

Create `src/services/schedule/weekdays.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { parseWeekdays, weekdayNames } from './weekdays';

describe('parseWeekdays', () => {
  test('parses names (case-insensitive)', () => {
    expect(parseWeekdays('mon,wed,fri')).toEqual([1, 3, 5]);
    expect(parseWeekdays('Mon, Wed, Fri')).toEqual([1, 3, 5]);
    expect(parseWeekdays('sun')).toEqual([7]);
  });
  test('parses numbers 1..7', () => {
    expect(parseWeekdays('1,3,5')).toEqual([1, 3, 5]);
    expect(parseWeekdays('7')).toEqual([7]);
  });
  test('sorts and dedupes', () => {
    expect(parseWeekdays('fri,mon,mon')).toEqual([1, 5]);
  });
  test('rejects invalid', () => {
    expect(() => parseWeekdays('')).toThrow();
    expect(() => parseWeekdays('xyz')).toThrow();
    expect(() => parseWeekdays('0')).toThrow();
    expect(() => parseWeekdays('8')).toThrow();
  });
});

describe('weekdayNames', () => {
  test('returns canonical names', () => {
    expect(weekdayNames([1, 3, 5])).toBe('Mon, Wed, Fri');
  });
});
```

- [ ] **Step 6: Implement `weekdays.ts`**

```typescript
const NAME_TO_NUM: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};
const NUM_TO_NAME = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Parse "mon,wed,fri" or "1,3,5" -> sorted unique [1..7]. 1=Mon, 7=Sun. */
export function parseWeekdays(input: string): number[] {
  if (!input) throw new Error('Weekdays is empty');
  const parts = input.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Weekdays is empty');
  const set = new Set<number>();
  for (const part of parts) {
    const num = /^\d+$/.test(part) ? parseInt(part, 10) : NAME_TO_NUM[part.toLowerCase()];
    if (num === undefined || num < 1 || num > 7) {
      throw new Error(`Invalid weekday: "${part}" (expected mon..sun or 1..7)`);
    }
    set.add(num);
  }
  return [...set].sort((a, b) => a - b);
}

/** Format [1,3,5] -> "Mon, Wed, Fri". */
export function weekdayNames(nums: number[]): string {
  return nums.map((n) => NUM_TO_NAME[n] ?? String(n)).join(', ');
}
```

- [ ] **Step 7: Run both test files — should pass**

Run: `bun test src/services/schedule/duration.test.ts src/services/schedule/weekdays.test.ts`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/services/schedule/duration.ts src/services/schedule/duration.test.ts src/services/schedule/weekdays.ts src/services/schedule/weekdays.test.ts
git commit -m "feat(schedule): add duration and weekdays parsers"
```

---

## Task 4: Folder hash and schedule calculator

**Files:**
- Create: `src/services/schedule/folder-hash.ts`
- Create: `src/services/schedule/schedule-calculator.ts`
- Test: `src/services/schedule/folder-hash.test.ts`
- Test: `src/services/schedule/schedule-calculator.test.ts`

- [ ] **Step 1: Write folder-hash tests**

Create `src/services/schedule/folder-hash.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { folderHash } from './folder-hash';

describe('folderHash', () => {
  test('is deterministic', () => {
    expect(folderHash('/Users/foo/proj')).toBe(folderHash('/Users/foo/proj'));
  });
  test('differs for different paths', () => {
    expect(folderHash('/Users/foo/a')).not.toBe(folderHash('/Users/foo/b'));
  });
  test('is hex', () => {
    expect(folderHash('/x')).toMatch(/^[0-9a-f]+$/);
  });
});
```

- [ ] **Step 2: Implement `folder-hash.ts`**

```typescript
/**
 * djb2 hash of a string, returned as a hex string. Matches claude-cron's label
 * hashing so behavior is consistent across both tools.
 */
export function folderHash(path: string): string {
  let hash = 5381n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(path);
  for (const b of bytes) {
    hash = ((hash * 33n) + BigInt(b)) & mask;
  }
  return hash.toString(16);
}
```

- [ ] **Step 3: Run — should pass**

Run: `bun test src/services/schedule/folder-hash.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Write schedule-calculator tests**

Create `src/services/schedule/schedule-calculator.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { nextRuns } from './schedule-calculator';

describe('nextRuns', () => {
  const now = new Date('2026-04-22T10:00:00Z'); // Wed

  test('manual returns empty', () => {
    expect(nextRuns({ type: 'manual' }, 5, now)).toEqual([]);
  });

  test('daily returns N future times', () => {
    const runs = nextRuns({ type: 'daily', hour: 9, minute: 0 }, 3, now);
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      expect(r.getTime()).toBeGreaterThan(now.getTime());
      expect(r.getHours()).toBe(9);
      expect(r.getMinutes()).toBe(0);
    }
  });

  test('interval advances by N minutes', () => {
    const runs = nextRuns({ type: 'interval', intervalMinutes: 30 }, 3, now);
    expect(runs).toHaveLength(3);
    expect(runs[1].getTime() - runs[0].getTime()).toBe(30 * 60 * 1000);
  });

  test('weekly only hits configured weekdays', () => {
    const runs = nextRuns({ type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] }, 5, now);
    // 1=Mon, 3=Wed, 5=Fri (JS getDay: Sun=0..Sat=6; our: 1=Mon..7=Sun)
    for (const r of runs) {
      const d = r.getDay();
      const ourDay = d === 0 ? 7 : d;
      expect([1, 3, 5]).toContain(ourDay);
      expect(r.getHours()).toBe(9);
    }
  });

  test('monthly uses the day field', () => {
    const runs = nextRuns({ type: 'monthly', day: 15, hour: 9, minute: 0 }, 2, now);
    expect(runs).toHaveLength(2);
    expect(runs[0].getDate()).toBe(15);
    expect(runs[1].getDate()).toBe(15);
  });
});
```

- [ ] **Step 5: Implement `schedule-calculator.ts`**

```typescript
import type { Schedule } from '../../types/schedule';

/**
 * Return the next N scheduled run times, strictly after `now`.
 * All Date math uses local time (same timezone launchd schedules against).
 */
export function nextRuns(schedule: Schedule, count: number, now: Date = new Date()): Date[] {
  const runs: Date[] = [];
  switch (schedule.type) {
    case 'manual':
      return runs;

    case 'daily': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      let candidate = atHour(now, h, m);
      if (candidate <= now) candidate = addDays(candidate, 1);
      while (runs.length < count) {
        runs.push(candidate);
        candidate = addDays(candidate, 1);
      }
      return runs;
    }

    case 'weekly': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      const days = schedule.weekdays ?? [];
      let cursor = atHour(now, h, m);
      while (runs.length < count && runs.length < 500) {
        const d = cursor.getDay();
        const ourDay = d === 0 ? 7 : d;
        if (days.includes(ourDay) && cursor > now) {
          runs.push(new Date(cursor));
        }
        cursor = addDays(cursor, 1);
      }
      return runs;
    }

    case 'monthly': {
      const h = schedule.hour ?? 0;
      const m = schedule.minute ?? 0;
      const targetDay = schedule.day ?? 1;
      let year = now.getFullYear();
      let month = now.getMonth();
      while (runs.length < count) {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const day = Math.min(targetDay, daysInMonth);
        const candidate = new Date(year, month, day, h, m, 0, 0);
        if (candidate > now) runs.push(candidate);
        month += 1;
        if (month > 11) { month = 0; year += 1; }
      }
      return runs;
    }

    case 'interval': {
      const mins = schedule.intervalMinutes ?? 60;
      let t = new Date(now.getTime() + mins * 60_000);
      while (runs.length < count) {
        runs.push(t);
        t = new Date(t.getTime() + mins * 60_000);
      }
      return runs;
    }
  }
}

function atHour(base: Date, h: number, m: number): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
```

- [ ] **Step 6: Run — should pass**

Run: `bun test src/services/schedule/schedule-calculator.test.ts`
Expected: 5 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/schedule/folder-hash.ts src/services/schedule/folder-hash.test.ts src/services/schedule/schedule-calculator.ts src/services/schedule/schedule-calculator.test.ts
git commit -m "feat(schedule): add folder hash and schedule calculator"
```

---

## Task 5: State file reader/writer

**Files:**
- Create: `src/services/schedule/state.ts`
- Test: `src/services/schedule/state.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/schedule/state.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readState, writeState, updateState } from './state';

describe('state', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentio-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads empty object when file missing', async () => {
    expect(await readState(dir)).toEqual({});
  });

  test('writes then reads', async () => {
    await writeState(dir, { foo: { sessionId: 'abc', lastRunAt: '2026-04-22T00:00:00Z' } });
    expect(await readState(dir)).toEqual({ foo: { sessionId: 'abc', lastRunAt: '2026-04-22T00:00:00Z' } });
  });

  test('updateState merges', async () => {
    await writeState(dir, { foo: { sessionId: 'old' } });
    await updateState(dir, 'foo', { lastRunAt: '2026-04-22T01:00:00Z' });
    expect(await readState(dir)).toEqual({ foo: { sessionId: 'old', lastRunAt: '2026-04-22T01:00:00Z' } });
  });

  test('returns empty for corrupt json', async () => {
    writeFileSync(join(dir, '.agentio', 'state.json'), '{not json', { flag: 'w' });
    // (.agentio dir doesn't exist yet — write without mkdir would fail; do mkdir first)
  });
});
```

Note: the corrupt-json test needs `.agentio` to exist. Rewrite as:

```typescript
  test('returns empty for corrupt json', async () => {
    await writeState(dir, {}); // creates .agentio/
    writeFileSync(join(dir, '.agentio', 'state.json'), '{not json');
    expect(await readState(dir)).toEqual({});
  });
```

- [ ] **Step 2: Run — should fail (module missing)**

Run: `bun test src/services/schedule/state.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `state.ts`**

```typescript
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ScheduleState, StateFile } from '../../types/schedule';

function stateFilePath(folder: string): string {
  return join(folder, '.agentio', 'state.json');
}

async function ensureAgentioDir(folder: string): Promise<void> {
  const dir = join(folder, '.agentio');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function readState(folder: string): Promise<StateFile> {
  const path = stateFilePath(folder);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeState(folder: string, state: StateFile): Promise<void> {
  await ensureAgentioDir(folder);
  await writeFile(stateFilePath(folder), JSON.stringify(state, null, 2));
}

export async function updateState(
  folder: string,
  id: string,
  patch: Partial<ScheduleState>
): Promise<void> {
  const state = await readState(folder);
  state[id] = { ...(state[id] ?? {}), ...patch };
  await writeState(folder, state);
}
```

- [ ] **Step 4: Run — should pass**

Run: `bun test src/services/schedule/state.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/schedule/state.ts src/services/schedule/state.test.ts
git commit -m "feat(schedule): add state file read/write"
```

---

## Task 6: launchd plist builder (pure)

**Files:**
- Create: `src/services/schedule/plist-builder.ts`
- Test: `src/services/schedule/plist-builder.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/schedule/plist-builder.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { buildPlistDict, plistLabel } from './plist-builder';
import type { FrontmatterConfig } from '../../types/schedule';

const folder = '/Users/foo/proj';
const id = 'test';

function baseConfig(overrides: Partial<FrontmatterConfig>): FrontmatterConfig {
  return {
    schedule: { type: 'manual' },
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    sessionMode: 'new',
    enabled: true,
    ...overrides,
  };
}

describe('plistLabel', () => {
  test('uses folder hash + id', () => {
    const label = plistLabel(folder, id);
    expect(label).toMatch(/^com\.agentio\.schedule\.[0-9a-f]+-test$/);
  });
});

describe('buildPlistDict', () => {
  test('manual: no trigger keys', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'manual' } }));
    expect(dict.StartCalendarInterval).toBeUndefined();
    expect(dict.StartInterval).toBeUndefined();
    expect(dict.RunAtLoad).toBe(false);
  });

  test('daily: StartCalendarInterval dict', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'daily', hour: 21, minute: 30 } }));
    expect(dict.StartCalendarInterval).toEqual({ Hour: 21, Minute: 30 });
  });

  test('weekly: array of dicts, launchd weekday = our weekday (Sun=7 -> 0)', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'weekly', hour: 9, minute: 0, weekdays: [1, 5, 7] } }));
    expect(dict.StartCalendarInterval).toEqual([
      { Weekday: 1, Hour: 9, Minute: 0 },
      { Weekday: 5, Hour: 9, Minute: 0 },
      { Weekday: 0, Hour: 9, Minute: 0 },
    ]);
  });

  test('monthly: StartCalendarInterval with Day', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'monthly', day: 15, hour: 9, minute: 0 } }));
    expect(dict.StartCalendarInterval).toEqual({ Day: 15, Hour: 9, Minute: 0 });
  });

  test('interval: StartInterval in seconds', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'interval', intervalMinutes: 30 } }));
    expect(dict.StartInterval).toBe(1800);
  });

  test('ProgramArguments references the id and folder', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ schedule: { type: 'manual' } }));
    expect(dict.ProgramArguments).toEqual([
      '/bin/zsh', '-lic',
      'agentio schedule run test --folder /Users/foo/proj --from-launchd',
    ]);
  });

  test('disabled: dict still built (caller decides to install or not)', () => {
    const dict = buildPlistDict(folder, id, baseConfig({ enabled: false, schedule: { type: 'daily', hour: 9, minute: 0 } }));
    expect(dict.StartCalendarInterval).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — should fail**

Run: `bun test src/services/schedule/plist-builder.test.ts`
Expected: module-not-found.

- [ ] **Step 3: Implement `plist-builder.ts`**

```typescript
import { join } from 'path';
import { folderHash } from './folder-hash';
import type { FrontmatterConfig } from '../../types/schedule';

export const LABEL_PREFIX = 'me.agentio.schedule';

export function plistLabel(folder: string, id: string): string {
  return `${LABEL_PREFIX}.${folderHash(folder)}-${id}`;
}

export function plistFileName(folder: string, id: string): string {
  return `${plistLabel(folder, id)}.plist`;
}

export interface PlistDict {
  Label: string;
  ProgramArguments: string[];
  RunAtLoad: boolean;
  StandardOutPath: string;
  StandardErrorPath: string;
  StartCalendarInterval?: Record<string, number> | Record<string, number>[];
  StartInterval?: number;
}

export function buildPlistDict(
  folder: string,
  id: string,
  config: FrontmatterConfig
): PlistDict {
  const label = plistLabel(folder, id);
  const logBase = join(folder, '.agentio', 'runs', id);
  const dict: PlistDict = {
    Label: label,
    ProgramArguments: [
      '/bin/zsh',
      '-lic',
      `agentio schedule run ${id} --folder ${folder} --from-launchd`,
    ],
    RunAtLoad: false,
    StandardOutPath: join(logBase, 'launchd.log'),
    StandardErrorPath: join(logBase, 'launchd.log'),
  };

  const s = config.schedule;
  switch (s.type) {
    case 'manual':
      break;
    case 'daily':
      dict.StartCalendarInterval = { Hour: s.hour ?? 0, Minute: s.minute ?? 0 };
      break;
    case 'weekly': {
      const h = s.hour ?? 0;
      const m = s.minute ?? 0;
      const days = s.weekdays ?? [];
      dict.StartCalendarInterval = days.map((ourDay) => ({
        Weekday: ourDay === 7 ? 0 : ourDay, // 1=Mon..7=Sun -> launchd 1..6 + 0 for Sun
        Hour: h,
        Minute: m,
      }));
      break;
    }
    case 'monthly':
      dict.StartCalendarInterval = {
        Day: s.day ?? 1,
        Hour: s.hour ?? 0,
        Minute: s.minute ?? 0,
      };
      break;
    case 'interval':
      dict.StartInterval = (s.intervalMinutes ?? 60) * 60;
      break;
  }

  return dict;
}
```

- [ ] **Step 4: Run — should pass**

Run: `bun test src/services/schedule/plist-builder.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/schedule/plist-builder.ts src/services/schedule/plist-builder.test.ts
git commit -m "feat(schedule): add pure plist-dict builder"
```

---

## Task 7: launchd install/uninstall/enumerate

**Files:**
- Create: `src/services/schedule/launchd.ts`
- Test: `src/services/schedule/launchd.test.ts`

Only pure enumeration from a given directory of plist XML files is tested; install/uninstall actually call `launchctl` and are covered manually in the end-to-end smoke test.

- [ ] **Step 1: Write failing enumeration test**

Create `src/services/schedule/launchd.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import plist from 'plist';
import { enumerateInstalledSchedules } from './launchd';

describe('enumerateInstalledSchedules', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentio-launchd-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writePlist(label: string, dict: Record<string, unknown>): void {
    writeFileSync(join(dir, `${label}.plist`), plist.build(dict));
  }

  test('skips non-agentio plists', () => {
    writePlist('com.other.tool', { Label: 'com.other.tool', ProgramArguments: ['x'] });
    const result = enumerateInstalledSchedules(dir);
    expect(result).toEqual([]);
  });

  test('extracts id and folder from ProgramArguments', () => {
    writePlist('me.agentio.schedule.abc-mytask', {
      Label: 'me.agentio.schedule.abc-mytask',
      ProgramArguments: [
        '/bin/zsh', '-lic',
        'agentio schedule run mytask --folder /Users/x/proj --from-launchd',
      ],
    });
    const result = enumerateInstalledSchedules(dir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      label: 'me.agentio.schedule.abc-mytask',
      plistPath: join(dir, 'me.agentio.schedule.abc-mytask.plist'),
      id: 'mytask',
      folder: '/Users/x/proj',
    });
  });

  test('skips malformed agentio plists', () => {
    writePlist('me.agentio.schedule.bad', { Label: 'me.agentio.schedule.bad', ProgramArguments: ['nope'] });
    expect(enumerateInstalledSchedules(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `launchd.ts`**

```typescript
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import plist from 'plist';
import { buildPlistDict, LABEL_PREFIX, plistFileName, plistLabel } from './plist-builder';
import type { FrontmatterConfig } from '../../types/schedule';

export const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

export interface InstalledSchedule {
  label: string;
  plistPath: string;
  id: string;
  folder: string;
}

function parseProgramArgs(args: string[]): { id: string; folder: string } | null {
  // ["/bin/zsh", "-lic", "agentio schedule run <id> --folder <abs> --from-launchd"]
  if (args.length !== 3) return null;
  const cmd = args[2];
  const match = cmd.match(/^agentio schedule run (\S+) --folder (.+) --from-launchd$/);
  if (!match) return null;
  return { id: match[1], folder: match[2] };
}

/** Pure: read plist files from a directory. Exposed as a parameter for testing. */
export function enumerateInstalledSchedules(dir: string = LAUNCH_AGENTS_DIR): InstalledSchedule[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter(
    (f) => f.startsWith(LABEL_PREFIX + '.') && f.endsWith('.plist')
  );
  const result: InstalledSchedule[] = [];
  for (const file of entries) {
    const plistPath = join(dir, file);
    try {
      const raw = readFileSync(plistPath, 'utf-8');
      const parsed = plist.parse(raw) as Record<string, unknown>;
      const args = parsed.ProgramArguments as string[] | undefined;
      const label = parsed.Label as string | undefined;
      if (!args || !label) continue;
      const info = parseProgramArgs(args);
      if (!info) continue;
      result.push({ label, plistPath, id: info.id, folder: info.folder });
    } catch {
      continue;
    }
  }
  return result;
}

export function installPlist(
  folder: string,
  id: string,
  config: FrontmatterConfig
): void {
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }
  const path = join(LAUNCH_AGENTS_DIR, plistFileName(folder, id));
  // ensure <folder>/.agentio/runs/<id>/ exists (for StandardOutPath target)
  mkdirSync(join(folder, '.agentio', 'runs', id), { recursive: true });

  // If an existing plist is loaded, unload first so we can replace it
  if (existsSync(path)) {
    try { execFileSync('/bin/launchctl', ['unload', path], { stdio: 'ignore' }); }
    catch { /* ignore */ }
  }

  const dict = buildPlistDict(folder, id, config);
  // If disabled, still write the file but don't load (caller can decide)
  writeFileSync(path, plist.build(dict as unknown as plist.PlistObject));
  if (config.enabled) {
    try {
      execFileSync('/bin/launchctl', ['load', path], { stdio: 'ignore' });
    } catch (err) {
      // rollback the plist on load failure
      try { unlinkSync(path); } catch { /* ignore */ }
      throw err;
    }
  }
}

export function uninstallPlist(folder: string, id: string): void {
  const path = join(LAUNCH_AGENTS_DIR, plistFileName(folder, id));
  try { execFileSync('/bin/launchctl', ['unload', path], { stdio: 'ignore' }); }
  catch { /* ignore */ }
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

export function plistLabelFor(folder: string, id: string): string {
  return plistLabel(folder, id);
}
```

- [ ] **Step 3: Run — should pass**

Run: `bun test src/services/schedule/launchd.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/schedule/launchd.ts src/services/schedule/launchd.test.ts
git commit -m "feat(schedule): add launchd install/uninstall/enumerate"
```

---

## Task 8: Folder walker for *.run.md files

**Files:**
- Create: `src/services/schedule/walker.ts`
- Test: `src/services/schedule/walker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/schedule/walker.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { walkRunFiles } from './walker';

describe('walkRunFiles', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentio-walk-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function touch(rel: string): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '');
  }

  test('finds *.run.md files in subtree', () => {
    touch('foo.run.md');
    touch('prompts/bar.run.md');
    touch('deep/nested/baz.run.md');
    touch('README.md'); // not matched
    const result = walkRunFiles(root);
    expect(result.map((r) => r.id).sort()).toEqual(['bar', 'baz', 'foo']);
  });

  test('skips node_modules, .git, .agentio/runs', () => {
    touch('real.run.md');
    touch('node_modules/a.run.md');
    touch('.git/hidden.run.md');
    touch('.agentio/runs/x/ignored.run.md');
    const result = walkRunFiles(root);
    expect(result.map((r) => r.id)).toEqual(['real']);
  });

  test('id = filename minus .run.md', () => {
    touch('my-task.run.md');
    const result = walkRunFiles(root);
    expect(result[0].id).toBe('my-task');
  });
});
```

- [ ] **Step 2: Implement `walker.ts`**

```typescript
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface RunFile {
  /** absolute path */
  path: string;
  /** id = basename without ".run.md" */
  id: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

export function walkRunFiles(root: string): RunFile[] {
  const out: RunFile[] = [];
  walk(root, root, out);
  return out;
}

function walk(root: string, dir: string, out: RunFile[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      // Skip <root>/.agentio/runs specifically (but allow *.run.md inside .agentio/ otherwise)
      if (full === join(root, '.agentio', 'runs')) continue;
      walk(root, full, out);
    } else if (st.isFile() && name.endsWith('.run.md')) {
      out.push({ path: full, id: name.slice(0, -'.run.md'.length) });
    }
  }
}
```

- [ ] **Step 3: Run — should pass**

Run: `bun test src/services/schedule/walker.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/schedule/walker.ts src/services/schedule/walker.test.ts
git commit -m "feat(schedule): add run-file walker"
```

---

## Task 9: Claude binary locator

**Files:**
- Create: `src/services/schedule/claude-binary.ts`

No unit test — interacts with real shell. Validated manually during the smoke test (Task 19).

- [ ] **Step 1: Implement**

```typescript
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';

let cachedShellEnv: Record<string, string> | null = null;

/** Cached login-shell env (PATH etc.), mimicking claude-cron. */
export function shellEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv;
  try {
    const out = execFileSync('/bin/zsh', ['-lic', 'env'], { encoding: 'utf-8' });
    const env: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!env.PATH) Object.assign(env, process.env);
    cachedShellEnv = env;
  } catch {
    cachedShellEnv = { ...process.env } as Record<string, string>;
  }
  return cachedShellEnv;
}

/** Locate the `claude` CLI binary, returning an absolute path or null. */
export function locateClaude(): string | null {
  const env = shellEnv();
  const paths = (env.PATH ?? '').split(':');
  for (const dir of paths) {
    if (!dir) continue;
    const candidate = `${dir}/claude`;
    if (existsSync(candidate)) return candidate;
  }
  const fallbacks = [
    `${homedir()}/.claude/local/bin/claude`,
    `${homedir()}/.local/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of fallbacks) {
    if (existsSync(p)) return p;
  }
  return null;
}
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/schedule/claude-binary.ts
git commit -m "feat(schedule): add claude binary locator"
```

---

## Task 10: Runner (spawn + stream + log + update state)

**Files:**
- Create: `src/services/schedule/runner.ts`
- Test: `src/services/schedule/runner.test.ts`

- [ ] **Step 1: Write a failing test that injects a stub spawner**

Create `src/services/schedule/runner.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runSchedule, type Spawner } from './runner';
import type { FrontmatterConfig } from '../../types/schedule';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): void {}
}

function makeSpawner(lines: string[], exitCode: number): { spawner: Spawner; child: FakeChild } {
  const child = new FakeChild();
  const spawner: Spawner = () => {
    setImmediate(() => {
      for (const l of lines) child.stdout.emit('data', Buffer.from(l + '\n'));
      child.emit('close', exitCode);
    });
    return child as unknown as ReturnType<Spawner>;
  };
  return { spawner, child };
}

const config: FrontmatterConfig = {
  schedule: { type: 'manual' },
  model: 'sonnet',
  permissionMode: 'bypassPermissions',
  sessionMode: 'new',
  enabled: true,
};

describe('runSchedule', () => {
  let folder: string;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'agentio-run-')); });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

  test('captures session_id from init event, writes summary line, returns exit code', async () => {
    const { spawner } = makeSpawner(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ],
      0
    );
    const { exitCode, logPath } = await runSchedule({
      folder, id: 'test', promptBody: 'hi', config, spawner,
      claudePath: '/fake/claude', now: () => new Date('2026-04-22T10:00:00Z'),
    });
    expect(exitCode).toBe(0);
    const log = readFileSync(logPath, 'utf-8');
    const summary = JSON.parse(log.trim().split('\n').pop()!);
    expect(summary.type).toBe('summary');
    expect(summary.sessionId).toBe('sess-123');
    expect(summary.exitCode).toBe(0);
  });

  test('failure path: non-zero exit propagated', async () => {
    const { spawner } = makeSpawner([], 2);
    const { exitCode } = await runSchedule({
      folder, id: 'test', promptBody: 'hi', config, spawner,
      claudePath: '/fake/claude', now: () => new Date('2026-04-22T10:00:00Z'),
    });
    expect(exitCode).toBe(2);
  });

  test('creates .agentio/runs/<id>/<ts>.log', async () => {
    const { spawner } = makeSpawner([], 0);
    await runSchedule({
      folder, id: 'test', promptBody: 'hi', config, spawner,
      claudePath: '/fake/claude', now: () => new Date('2026-04-22T10:00:00Z'),
    });
    const runsDir = join(folder, '.agentio', 'runs', 'test');
    expect(existsSync(runsDir)).toBe(true);
    expect(readdirSync(runsDir).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement `runner.ts`**

```typescript
import { spawn, type ChildProcess } from 'child_process';
import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { FrontmatterConfig } from '../../types/schedule';
import { shellEnv, locateClaude } from './claude-binary';
import { updateState } from './state';

export type Spawner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcess;

export interface RunScheduleOpts {
  folder: string;
  id: string;
  promptBody: string;
  config: FrontmatterConfig;
  /** injected for tests; defaults to child_process.spawn */
  spawner?: Spawner;
  /** injected for tests; defaults to locateClaude() */
  claudePath?: string | null;
  now?: () => Date;
}

export interface RunResult {
  exitCode: number;
  logPath: string;
  sessionId?: string;
}

export async function runSchedule(opts: RunScheduleOpts): Promise<RunResult> {
  const now = (opts.now ?? (() => new Date()))();
  const runsDir = join(opts.folder, '.agentio', 'runs', opts.id);
  await mkdir(runsDir, { recursive: true });
  const ts = now.toISOString().replace(/[:]/g, '-');
  const logPath = join(runsDir, `${ts}.log`);

  const spawner = opts.spawner ?? (spawn as Spawner);
  const env = { ...shellEnv() } as Record<string, string>;
  delete env.CLAUDECODE;

  let cmd: string;
  let args: string[];
  if (opts.config.command) {
    cmd = '/bin/zsh';
    args = ['-lic', opts.config.command];
  } else {
    const claude = opts.claudePath ?? locateClaude();
    if (!claude) {
      await appendFile(logPath,
        'ERROR: claude CLI not found. Tried PATH + ~/.claude/local/bin, ~/.local/bin, /usr/local/bin, /opt/homebrew/bin.\n');
      await writeSummary(logPath, { status: 'failed', exitCode: 127, startedAt: now, endedAt: new Date() });
      return { exitCode: 127, logPath };
    }
    cmd = claude;
    args = buildClaudeArgs(opts.config, opts.promptBody);
  }

  await appendFile(logPath, `[${now.toISOString()}] spawn: ${cmd} ${args.map(a => JSON.stringify(a)).join(' ')}\n`);

  const child = spawner(cmd, args, { cwd: opts.folder, env });
  const startedAt = now;
  let sessionId: string | undefined;
  let buffer = '';

  child.stdout?.on('data', async (chunk: Buffer) => {
    const text = chunk.toString('utf-8');
    await appendFile(logPath, text);
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
          sessionId = obj.session_id;
          await updateState(opts.folder, opts.id, { sessionId });
        }
      } catch { /* not JSON */ }
    }
  });

  child.stderr?.on('data', async (chunk: Buffer) => {
    await appendFile(logPath, chunk.toString('utf-8'));
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });

  const endedAt = new Date();
  const status = exitCode === 0 ? 'succeeded' : 'failed';
  await writeSummary(logPath, { status, exitCode, sessionId, startedAt, endedAt });
  await updateState(opts.folder, opts.id, {
    lastRunAt: endedAt.toISOString(),
    lastExitCode: exitCode,
    ...(sessionId ? { sessionId } : {}),
  });

  return { exitCode, logPath, sessionId };
}

function buildClaudeArgs(config: FrontmatterConfig, prompt: string): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--model', config.model];
  switch (config.permissionMode) {
    case 'bypassPermissions': args.push('--dangerously-skip-permissions'); break;
    case 'plan':               args.push('--permission-mode', 'plan'); break;
    case 'acceptEdits':        args.push('--permission-mode', 'acceptEdits'); break;
    case 'default':            break;
  }
  args.push(prompt);
  return args;
}

async function writeSummary(logPath: string, fields: {
  status: string; exitCode: number; sessionId?: string; startedAt: Date; endedAt: Date;
}): Promise<void> {
  const summary = {
    type: 'summary',
    status: fields.status,
    exitCode: fields.exitCode,
    durationMs: fields.endedAt.getTime() - fields.startedAt.getTime(),
    sessionId: fields.sessionId,
    startedAt: fields.startedAt.toISOString(),
    endedAt: fields.endedAt.toISOString(),
  };
  await appendFile(logPath, '\n' + JSON.stringify(summary) + '\n');
}
```

- [ ] **Step 3: Run — should pass**

Run: `bun test src/services/schedule/runner.test.ts`
Expected: 3 tests pass.

Note: the test's `spawner` ignores the `sessionMode: resume/fork` branches — which only add args, don't change the spawn behavior. Those are covered by `buildClaudeArgs` in Task 18 where we add an explicit args-building test.

- [ ] **Step 4: Commit**

```bash
git add src/services/schedule/runner.ts src/services/schedule/runner.test.ts
git commit -m "feat(schedule): add runner with stream-json session capture"
```

---

## Task 11: Runs enumerator

**Files:**
- Create: `src/services/schedule/runs.ts`
- Test: `src/services/schedule/runs.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/schedule/runs.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listRuns } from './runs';

describe('listRuns', () => {
  let folder: string;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'agentio-runs-')); });
  afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

  test('returns empty when no runs dir', () => {
    expect(listRuns(folder, 'foo')).toEqual([]);
  });

  test('parses summary line from log tail', () => {
    const dir = join(folder, '.agentio', 'runs', 'foo');
    mkdirSync(dir, { recursive: true });
    const summary = { type: 'summary', status: 'succeeded', exitCode: 0, durationMs: 1234, sessionId: 'abc', startedAt: '2026-04-22T10:00:00Z', endedAt: '2026-04-22T10:00:01Z' };
    writeFileSync(join(dir, '2026-04-22T10-00-00Z.log'),
      'some logs\n' + JSON.stringify(summary) + '\n');
    const runs = listRuns(folder, 'foo');
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('succeeded');
    expect(runs[0].sessionId).toBe('abc');
  });

  test('newest first', () => {
    const dir = join(folder, '.agentio', 'runs', 'foo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-04-22T10-00-00Z.log'), '');
    writeFileSync(join(dir, '2026-04-23T10-00-00Z.log'), '');
    const runs = listRuns(folder, 'foo');
    expect(runs[0].file).toMatch(/2026-04-23/);
  });
});
```

- [ ] **Step 2: Implement `runs.ts`**

```typescript
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface RunEntry {
  file: string;
  path: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  sessionId?: string;
}

export function listRuns(folder: string, id: string): RunEntry[] {
  const dir = join(folder, '.agentio', 'runs', id);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.log') && f !== 'launchd.log')
    .sort()
    .reverse();
  return files.map((file) => {
    const path = join(dir, file);
    const entry: RunEntry = { file, path };
    try {
      const raw = readFileSync(path, 'utf-8');
      const lines = raw.trim().split('\n');
      const last = lines[lines.length - 1];
      const obj = JSON.parse(last);
      if (obj.type === 'summary') {
        entry.status = obj.status;
        entry.exitCode = obj.exitCode;
        entry.durationMs = obj.durationMs;
        entry.sessionId = obj.sessionId;
        entry.startedAt = obj.startedAt;
        entry.endedAt = obj.endedAt;
      }
    } catch { /* ignore */ }
    return entry;
  });
}
```

- [ ] **Step 3: Run — should pass**

Run: `bun test src/services/schedule/runs.test.ts`
Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/schedule/runs.ts src/services/schedule/runs.test.ts
git commit -m "feat(schedule): add runs enumerator"
```

---

## Task 12: Scaffold `schedule` command, wire into index.ts, register stub subcommands

**Files:**
- Create: `src/commands/schedule.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create `src/commands/schedule.ts` with empty subcommands**

```typescript
import { Command } from 'commander';
import { handleError } from '../utils/errors';

export function registerScheduleCommands(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('Schedule prompts to run on a cron-like schedule via launchd');

  schedule.command('add').description('Add or update a schedule (writes frontmatter + installs plist)')
    .argument('<file>', 'Path to the .run.md file (must end in .run.md)')
    .option('--folder <path>', 'Folder containing the file (default: CWD)')
    .option('--schedule <type>', 'manual | daily | weekly | monthly | interval')
    .option('--at <HH:MM>', 'Time of day shortcut for --hour/--minute')
    .option('--hour <n>', 'Hour 0-23')
    .option('--minute <n>', 'Minute 0-59')
    .option('--weekdays <list>', 'Weekly: mon,wed,fri or 1,3,5')
    .option('--day <n>', 'Monthly: day of month 1-31')
    .option('--interval <dur>', 'Interval: 30m, 2h, 1h30m')
    .option('--model <m>', 'opus | sonnet | haiku')
    .option('--permission-mode <m>', 'default | bypass | plan | accept-edits')
    .option('--session-mode <m>', 'new | resume | fork')
    .option('--command <cmd>', 'Command override (ignores model/permissionMode/sessionMode)')
    .option('--disabled', 'Create with enabled: false')
    .option('-y, --yes', 'Non-interactive; error if required flags missing')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('list').description('List installed schedules')
    .option('--folder <path>', 'Filter to one folder')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('sync').description('Reconcile launchd plists with *.run.md files')
    .option('--folder <path>', 'Folder to sync (default: CWD)')
    .option('-y, --yes', 'Non-interactive')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('remove').description('Delete a schedule and uninstall its plist')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .option('--from-launchd', 'Internal: flag set by launchd-triggered invocations')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('show').description('Show a schedule and next run times')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('runs').description('List past runs for a schedule')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });
}
```

- [ ] **Step 2: Wire into `src/index.ts`**

Add next to the other agentio-utility registrations. Find the block:

```typescript
// Agentio utilities
registerClaudeCommands(program);
```

Add this line above it (alphabetical with the other utilities):

```typescript
import { registerScheduleCommands } from './commands/schedule';
```

And after `registerReauthCommand(program);`:

```typescript
registerScheduleCommands(program);
```

- [ ] **Step 3: Type-check and CLI-smoke**

```bash
bun run typecheck
bun run dev schedule --help
```

Expected: `typecheck` passes. `--help` lists all 7 subcommands.

- [ ] **Step 4: Commit**

```bash
git add src/commands/schedule.ts src/index.ts
git commit -m "feat(schedule): scaffold schedule command with stubbed subcommands"
```

---

## Task 13: Implement `schedule add`

**Files:**
- Modify: `src/commands/schedule.ts`
- Create: `src/commands/schedule.test.ts` (for the flag-to-config mapping)

The command has a lot of flag parsing. We pull that into a pure helper and unit-test it.

- [ ] **Step 1: Add a pure `resolveConfigFromFlags` helper to `schedule.ts`**

At the top of `src/commands/schedule.ts`, **above** `registerScheduleCommands`, add:

```typescript
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { select, input } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { isInteractive } from '../utils/interactive';
import {
  mergeConfig,
  parseFrontmatter,
  serializeFrontmatter,
} from '../services/schedule/frontmatter';
import { parseDuration } from '../services/schedule/duration';
import { parseWeekdays } from '../services/schedule/weekdays';
import { installPlist } from '../services/schedule/launchd';
import type {
  FrontmatterConfig,
  Model,
  PermissionMode,
  Schedule,
  ScheduleType,
  SessionMode,
} from '../types/schedule';
import {
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_SESSION_MODE,
} from '../types/schedule';

export interface AddFlags {
  folder?: string;
  schedule?: string;
  at?: string;
  hour?: string;
  minute?: string;
  weekdays?: string;
  day?: string;
  interval?: string;
  model?: string;
  permissionMode?: string;
  sessionMode?: string;
  command?: string;
  disabled?: boolean;
  yes?: boolean;
}

const VALID_SCHEDULE_TYPES: ScheduleType[] = ['manual', 'daily', 'weekly', 'monthly', 'interval'];
const VALID_MODELS: Model[] = ['opus', 'sonnet', 'haiku'];
const VALID_PERMISSION_MODES: PermissionMode[] = ['default', 'bypassPermissions', 'plan', 'acceptEdits'];
const VALID_SESSION_MODES: SessionMode[] = ['new', 'resume', 'fork'];

/** Map --permission-mode CLI flag ("bypass"/"accept-edits") to frontmatter values. */
function mapPermissionMode(flag: string): PermissionMode {
  switch (flag) {
    case 'bypass': return 'bypassPermissions';
    case 'accept-edits': return 'acceptEdits';
    case 'default':
    case 'bypassPermissions':
    case 'plan':
    case 'acceptEdits': return flag as PermissionMode;
    default:
      throw new CliError('INVALID_PARAMS', `Invalid --permission-mode: "${flag}"`,
        'Use one of: default, bypass, plan, accept-edits');
  }
}

/** Pure: build a Schedule from flags. Throws CliError on bad input. */
export function scheduleFromFlags(flags: AddFlags): Schedule | undefined {
  if (!flags.schedule) return undefined;
  const type = flags.schedule as ScheduleType;
  if (!VALID_SCHEDULE_TYPES.includes(type)) {
    throw new CliError('INVALID_PARAMS', `Invalid --schedule: "${flags.schedule}"`,
      `Use one of: ${VALID_SCHEDULE_TYPES.join(', ')}`);
  }
  const parseHM = (): { hour: number; minute: number } | null => {
    if (flags.at) {
      const m = flags.at.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) throw new CliError('INVALID_PARAMS', `Invalid --at: "${flags.at}"`, 'Expected HH:MM');
      return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10) };
    }
    if (flags.hour !== undefined) {
      return { hour: parseInt(flags.hour, 10), minute: flags.minute ? parseInt(flags.minute, 10) : 0 };
    }
    return null;
  };

  switch (type) {
    case 'manual':
      return { type };
    case 'daily': {
      const hm = parseHM();
      if (!hm) return { type };
      return { type, hour: hm.hour, minute: hm.minute };
    }
    case 'weekly': {
      const hm = parseHM();
      const weekdays = flags.weekdays ? parseWeekdays(flags.weekdays) : undefined;
      return {
        type,
        ...(hm ? { hour: hm.hour, minute: hm.minute } : {}),
        ...(weekdays ? { weekdays } : {}),
      };
    }
    case 'monthly': {
      const hm = parseHM();
      const day = flags.day ? parseInt(flags.day, 10) : undefined;
      return {
        type,
        ...(hm ? { hour: hm.hour, minute: hm.minute } : {}),
        ...(day !== undefined ? { day } : {}),
      };
    }
    case 'interval': {
      const intervalMinutes = flags.interval ? parseDuration(flags.interval) : undefined;
      return { type, ...(intervalMinutes !== undefined ? { intervalMinutes } : {}) };
    }
  }
}

/** Pure: partial FrontmatterConfig from CLI flags. */
export function configFromFlags(flags: AddFlags): Partial<FrontmatterConfig> {
  const partial: Partial<FrontmatterConfig> = {};
  const schedule = scheduleFromFlags(flags);
  if (schedule) partial.schedule = schedule;
  if (flags.model) {
    if (!VALID_MODELS.includes(flags.model as Model)) {
      throw new CliError('INVALID_PARAMS', `Invalid --model: "${flags.model}"`,
        `Use one of: ${VALID_MODELS.join(', ')}`);
    }
    partial.model = flags.model as Model;
  }
  if (flags.permissionMode) partial.permissionMode = mapPermissionMode(flags.permissionMode);
  if (flags.sessionMode) {
    if (!VALID_SESSION_MODES.includes(flags.sessionMode as SessionMode)) {
      throw new CliError('INVALID_PARAMS', `Invalid --session-mode: "${flags.sessionMode}"`,
        `Use one of: ${VALID_SESSION_MODES.join(', ')}`);
    }
    partial.sessionMode = flags.sessionMode as SessionMode;
  }
  if (flags.command) partial.command = flags.command;
  if (flags.disabled) partial.enabled = false;
  return partial;
}

/** Required fields of a schedule by type. */
function missingScheduleFields(s: Schedule | undefined): string[] {
  if (!s) return ['schedule'];
  switch (s.type) {
    case 'manual': return [];
    case 'daily':
      return (s.hour === undefined || s.minute === undefined) ? ['hour', 'minute'] : [];
    case 'weekly': {
      const missing: string[] = [];
      if (!s.weekdays || s.weekdays.length === 0) missing.push('weekdays');
      if (s.hour === undefined || s.minute === undefined) missing.push('hour', 'minute');
      return missing;
    }
    case 'monthly': {
      const missing: string[] = [];
      if (s.day === undefined) missing.push('day');
      if (s.hour === undefined || s.minute === undefined) missing.push('hour', 'minute');
      return missing;
    }
    case 'interval':
      return s.intervalMinutes === undefined ? ['intervalMinutes'] : [];
  }
}
```

- [ ] **Step 2: Write unit tests for the pure helpers**

Create `src/commands/schedule.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { configFromFlags, scheduleFromFlags } from './schedule';
import { CliError } from '../utils/errors';

describe('scheduleFromFlags', () => {
  test('daily with --at', () => {
    expect(scheduleFromFlags({ schedule: 'daily', at: '21:00' })).toEqual({
      type: 'daily', hour: 21, minute: 0,
    });
  });
  test('weekly with weekdays', () => {
    expect(scheduleFromFlags({ schedule: 'weekly', at: '09:00', weekdays: 'mon,wed,fri' })).toEqual({
      type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5],
    });
  });
  test('interval with duration', () => {
    expect(scheduleFromFlags({ schedule: 'interval', interval: '30m' })).toEqual({
      type: 'interval', intervalMinutes: 30,
    });
  });
  test('invalid schedule type throws CliError', () => {
    expect(() => scheduleFromFlags({ schedule: 'bogus' })).toThrow(CliError);
  });
});

describe('configFromFlags', () => {
  test('maps --permission-mode bypass -> bypassPermissions', () => {
    expect(configFromFlags({ permissionMode: 'bypass' }).permissionMode).toBe('bypassPermissions');
  });
  test('rejects bad --model', () => {
    expect(() => configFromFlags({ model: 'gpt' })).toThrow(CliError);
  });
  test('--disabled sets enabled: false', () => {
    expect(configFromFlags({ disabled: true }).enabled).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests — should pass**

Run: `bun test src/commands/schedule.test.ts`
Expected: 7 tests pass.

- [ ] **Step 4: Implement the `add` action handler**

In `src/commands/schedule.ts`, replace the `add` action body (the one throwing "not implemented") with a real handler. Also add this helper above `registerScheduleCommands`:

```typescript
async function promptMissing(
  partial: Partial<FrontmatterConfig>,
  missing: string[]
): Promise<Partial<FrontmatterConfig>> {
  const out: Partial<FrontmatterConfig> = { ...partial };
  const s: Schedule = { ...(out.schedule ?? { type: 'manual' }) } as Schedule;

  if (missing.includes('schedule')) {
    s.type = await select({
      message: 'Schedule type:',
      choices: VALID_SCHEDULE_TYPES.map((t) => ({ name: t, value: t })),
    });
  }
  if (missing.includes('weekdays')) {
    const raw = await input({ message: 'Weekdays (e.g. mon,wed,fri):' });
    s.weekdays = parseWeekdays(raw);
  }
  if (missing.includes('day')) {
    const raw = await input({ message: 'Day of month (1-31):' });
    s.day = parseInt(raw, 10);
  }
  if (missing.includes('hour') || missing.includes('minute')) {
    const raw = await input({ message: 'Time of day (HH:MM):', default: '09:00' });
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new CliError('INVALID_PARAMS', `Invalid time: "${raw}"`, 'Expected HH:MM');
    s.hour = parseInt(m[1], 10);
    s.minute = parseInt(m[2], 10);
  }
  if (missing.includes('intervalMinutes')) {
    const raw = await input({ message: 'Interval (e.g. 30m, 2h, 1h30m):' });
    s.intervalMinutes = parseDuration(raw);
  }
  out.schedule = s;
  return out;
}
```

Then, inside `registerScheduleCommands`, replace the `add` action with:

```typescript
  schedule.command('add').description('Add or update a schedule (writes frontmatter + installs plist)')
    .argument('<file>', 'Path to the .run.md file (must end in .run.md)')
    .option('--folder <path>', 'Folder containing the file (default: CWD)')
    .option('--schedule <type>', 'manual | daily | weekly | monthly | interval')
    .option('--at <HH:MM>', 'Time of day shortcut for --hour/--minute')
    .option('--hour <n>', 'Hour 0-23')
    .option('--minute <n>', 'Minute 0-59')
    .option('--weekdays <list>', 'Weekly: mon,wed,fri or 1,3,5')
    .option('--day <n>', 'Monthly: day of month 1-31')
    .option('--interval <dur>', 'Interval: 30m, 2h, 1h30m')
    .option('--model <m>', 'opus | sonnet | haiku')
    .option('--permission-mode <m>', 'default | bypass | plan | accept-edits')
    .option('--session-mode <m>', 'new | resume | fork')
    .option('--command <cmd>', 'Command override')
    .option('--disabled', 'Create with enabled: false')
    .option('-y, --yes', 'Non-interactive; error if required flags missing')
    .action(async (file: string, opts: AddFlags) => {
      try {
        if (!file.endsWith('.run.md')) {
          throw new CliError('INVALID_PARAMS', `File must end in .run.md: "${file}"`);
        }
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const filePath = isAbsolute(file) ? file : resolve(folder, file);

        let existingBody = '# TODO: write your prompt here\n';
        let existingConfig: Partial<FrontmatterConfig> = {};
        if (existsSync(filePath)) {
          const raw = await readFile(filePath, 'utf-8');
          const parsed = parseFrontmatter(raw);
          existingConfig = parsed.config;
          if (parsed.body.trim()) existingBody = parsed.body;
        }

        const override = configFromFlags(opts);
        let merged: Partial<FrontmatterConfig> = {
          ...existingConfig,
          ...override,
          ...(override.schedule ? { schedule: override.schedule } : existingConfig.schedule ? { schedule: existingConfig.schedule } : {}),
        };

        const missing = missingScheduleFields(merged.schedule);
        if (missing.length > 0) {
          if (opts.yes || !isInteractive()) {
            throw new CliError('INVALID_PARAMS',
              `Missing required fields: ${missing.join(', ')}`,
              'Provide via flags or run interactively (no -y)');
          }
          merged = await promptMissing(merged, missing);
        }

        const finalConfig: FrontmatterConfig = mergeConfig({}, merged);

        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, serializeFrontmatter(finalConfig, existingBody));

        const id = file.split('/').pop()!.slice(0, -'.run.md'.length);
        installPlist(folder, id, finalConfig);

        console.log(`Installed schedule "${id}" in ${folder}`);
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 5: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/commands/schedule.ts src/commands/schedule.test.ts
git commit -m "feat(schedule): implement schedule add"
```

---

## Task 14: Implement `schedule sync`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Add the sync handler**

At the top of `registerScheduleCommands`, add this import near the others:

```typescript
import { walkRunFiles } from '../services/schedule/walker';
import { enumerateInstalledSchedules, uninstallPlist } from '../services/schedule/launchd';
import { folderHash } from '../services/schedule/folder-hash';
import { buildPlistDict } from '../services/schedule/plist-builder';
```

Then replace the `sync` stub with:

```typescript
  schedule.command('sync').description('Reconcile launchd plists with *.run.md files')
    .option('--folder <path>', 'Folder to sync (default: CWD)')
    .option('-y, --yes', 'Non-interactive')
    .action(async (opts: { folder?: string; yes?: boolean }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();

        // 1. Walk for *.run.md files
        const files = walkRunFiles(folder);

        // 2. Collision check
        const byId = new Map<string, string[]>();
        for (const f of files) {
          const arr = byId.get(f.id) ?? [];
          arr.push(f.path);
          byId.set(f.id, arr);
        }
        const collisions = [...byId.entries()].filter(([, v]) => v.length > 1);
        if (collisions.length > 0) {
          const lines = collisions.map(([id, paths]) => `  "${id}":\n    ${paths.join('\n    ')}`);
          throw new CliError('INVALID_PARAMS',
            `Multiple .run.md files share the same id:\n${lines.join('\n')}`,
            'Rename one of the files');
        }

        // 3. Ensure .agentio/.gitignore exists (first-time scaffolding)
        if (files.length > 0) {
          const giPath = resolve(folder, '.agentio', '.gitignore');
          await mkdir(dirname(giPath), { recursive: true });
          if (!existsSync(giPath)) {
            await writeFile(giPath, 'runs/\nstate.json\n');
          }
        }

        // 4. Build desired configs, prompting for incomplete files
        const desired = new Map<string, { config: FrontmatterConfig; body: string; filePath: string }>();
        for (const f of files) {
          const raw = await readFile(f.path, 'utf-8');
          const parsed = parseFrontmatter(raw);
          let config = parsed.config as Partial<FrontmatterConfig>;
          const missing = missingScheduleFields(config.schedule);
          if (missing.length > 0) {
            if (opts.yes || !isInteractive()) {
              throw new CliError('INVALID_PARAMS',
                `${f.path} is missing required fields: ${missing.join(', ')}`,
                'Fill in the frontmatter or run sync interactively');
            }
            console.log(`Filling in missing frontmatter for ${f.path}:`);
            config = await promptMissing(config, missing);
            const finalConfig = mergeConfig({}, config);
            await writeFile(f.path, serializeFrontmatter(finalConfig, parsed.body || '# TODO\n'));
            desired.set(f.id, { config: finalConfig, body: parsed.body, filePath: f.path });
          } else {
            desired.set(f.id, { config: mergeConfig({}, config), body: parsed.body, filePath: f.path });
          }
        }

        // 5. Diff against installed plists
        const installed = enumerateInstalledSchedules();
        const targetHash = folderHash(folder);
        const installedForFolder = installed.filter((p) => p.folder === folder || p.label.startsWith(`me.agentio.schedule.${targetHash}-`));

        const installedIds = new Set(installedForFolder.map((p) => p.id));
        const desiredIds = new Set(desired.keys());

        // 5a. Orphans: installed but no file -> uninstall
        for (const p of installedForFolder) {
          if (!desiredIds.has(p.id)) {
            uninstallPlist(folder, p.id);
            console.log(`Removed orphan plist: ${p.id}`);
          }
        }

        // 5b. New or changed: install/update
        for (const [id, { config }] of desired) {
          const dict = buildPlistDict(folder, id, config);
          let needsInstall = !installedIds.has(id);
          if (!needsInstall) {
            // Compare on-disk plist dict with desired dict
            const existing = installedForFolder.find((p) => p.id === id)!;
            try {
              const raw = await readFile(existing.plistPath, 'utf-8');
              const parsedDict = (await import('plist')).default.parse(raw) as Record<string, unknown>;
              if (JSON.stringify(parsedDict) !== JSON.stringify(dict)) needsInstall = true;
            } catch { needsInstall = true; }
          }
          if (needsInstall) {
            installPlist(folder, id, config);
            console.log(`Installed/updated: ${id}`);
          }
        }

        console.log(`Sync complete: ${desired.size} desired, ${installedForFolder.length - (installedForFolder.length - [...desiredIds].filter((id) => installedIds.has(id)).length)} already in sync.`);
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): implement schedule sync"
```

---

## Task 15: Implement `schedule list`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Add `schedule-calculator` import and replace the list stub**

Add to imports near the top (combine with existing imports as needed):

```typescript
import { readFileSync } from 'fs';
import { nextRuns } from '../services/schedule/schedule-calculator';
import { weekdayNames } from '../services/schedule/weekdays';
```

Add a pure helper above `registerScheduleCommands`:

```typescript
export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'manual': return 'Manual';
    case 'daily':
      return `Daily at ${fmtHM(s.hour, s.minute)}`;
    case 'weekly':
      return `Weekly ${weekdayNames(s.weekdays ?? [])} at ${fmtHM(s.hour, s.minute)}`;
    case 'monthly':
      return `Monthly on day ${s.day} at ${fmtHM(s.hour, s.minute)}`;
    case 'interval': {
      const m = s.intervalMinutes ?? 0;
      if (m < 60) return `Every ${m}m`;
      if (m % 60 === 0) return `Every ${m / 60}h`;
      return `Every ${Math.floor(m / 60)}h${m % 60}m`;
    }
  }
}

function fmtHM(h?: number, m?: number): string {
  return `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
}
```

Replace the `list` stub:

```typescript
  schedule.command('list').description('List installed schedules')
    .option('--folder <path>', 'Filter to one folder')
    .action(async (opts: { folder?: string }) => {
      try {
        const filterFolder = opts.folder ? resolve(opts.folder) : undefined;
        const installed = enumerateInstalledSchedules();
        const rows = installed
          .filter((p) => !filterFolder || p.folder === filterFolder)
          .map((p) => {
            const glob = walkRunFiles(p.folder).find((f) => f.id === p.id);
            if (!glob) {
              return {
                folder: p.folder, id: p.id, schedule: '[broken: .run.md missing]',
                model: '-', next: '-', enabled: '-',
              };
            }
            try {
              const raw = readFileSync(glob.path, 'utf-8');
              const parsed = parseFrontmatter(raw);
              const cfg = mergeConfig({}, parsed.config);
              const next = nextRuns(cfg.schedule, 1)[0];
              return {
                folder: p.folder, id: p.id, schedule: describeSchedule(cfg.schedule),
                model: cfg.command ? `cmd: ${cfg.command}` : cfg.model,
                next: next ? next.toISOString() : '-',
                enabled: cfg.enabled ? 'yes' : 'no',
              };
            } catch {
              return { folder: p.folder, id: p.id, schedule: '[parse error]', model: '-', next: '-', enabled: '-' };
            }
          });
        if (rows.length === 0) { console.log('No schedules installed.'); return; }
        for (const r of rows) {
          console.log(`${r.folder}  ${r.id}  ${r.schedule}  (${r.model})  next: ${r.next}  enabled: ${r.enabled}`);
        }
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): implement schedule list"
```

---

## Task 16: Implement `schedule remove`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Import `unlink`**

Add to the fs/promises import:

```typescript
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
```

Replace the `remove` stub:

```typescript
  schedule.command('remove').description('Delete a schedule and uninstall its plist')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length === 0) {
          // still attempt plist uninstall in case the file was already removed
          uninstallPlist(folder, id);
          throw new CliError('NOT_FOUND', `No .run.md file found for id "${id}" under ${folder}`,
            'Check the id (ls **/*.run.md) or run schedule list');
        }
        if (matches.length > 1) {
          throw new CliError('INVALID_PARAMS',
            `Multiple files match id "${id}": ${matches.map((m) => m.path).join(', ')}`);
        }
        await unlink(matches[0].path);
        uninstallPlist(folder, id);
        console.log(`Removed schedule "${id}" (deleted ${matches[0].path}, uninstalled plist)`);
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): implement schedule remove"
```

---

## Task 17: Implement `schedule show`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Replace the `show` stub**

```typescript
  schedule.command('show').description('Show a schedule and next run times')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length !== 1) {
          throw new CliError('NOT_FOUND', `No unique .run.md file for id "${id}" under ${folder}`);
        }
        const raw = await readFile(matches[0].path, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const cfg = mergeConfig({}, parsed.config);
        console.log(`id:            ${id}`);
        console.log(`file:          ${matches[0].path}`);
        console.log(`schedule:      ${describeSchedule(cfg.schedule)}`);
        console.log(`model:         ${cfg.model}`);
        console.log(`permissionMode:${cfg.permissionMode}`);
        console.log(`sessionMode:   ${cfg.sessionMode}`);
        console.log(`enabled:       ${cfg.enabled}`);
        if (cfg.command) console.log(`command:       ${cfg.command}`);
        console.log('next 5 runs:');
        for (const d of nextRuns(cfg.schedule, 5)) {
          console.log(`  ${d.toISOString()}`);
        }
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): implement schedule show"
```

---

## Task 18: Implement `schedule runs`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Add import**

```typescript
import { listRuns } from '../services/schedule/runs';
```

Replace the `runs` stub:

```typescript
  schedule.command('runs').description('List past runs for a schedule')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async (id: string, opts: { folder?: string }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const runs = listRuns(folder, id);
        if (runs.length === 0) { console.log(`No runs recorded for "${id}".`); return; }
        for (const r of runs) {
          const dur = r.durationMs !== undefined ? `${r.durationMs}ms` : '-';
          console.log(`${r.file}  status=${r.status ?? '?'}  exit=${r.exitCode ?? '?'}  duration=${dur}  session=${r.sessionId ?? '-'}`);
        }
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): implement schedule runs"
```

---

## Task 19: Implement `schedule run`

**Files:**
- Modify: `src/commands/schedule.ts`

This is the final hand-off to the runner module.

- [ ] **Step 1: Add import**

```typescript
import { runSchedule } from '../services/schedule/runner';
```

Replace the `run` stub:

```typescript
  schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .option('--from-launchd', 'Internal: flag set by launchd-triggered invocations')
    .action(async (id: string, opts: { folder?: string; fromLaunchd?: boolean }) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length !== 1) {
          throw new CliError('NOT_FOUND', `No unique .run.md file for id "${id}" under ${folder}`,
            'Run `agentio schedule list` to see available ids');
        }
        const raw = await readFile(matches[0].path, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const cfg = mergeConfig({}, parsed.config);
        const { exitCode, logPath } = await runSchedule({
          folder, id, promptBody: parsed.body, config: cfg,
        });
        if (!opts.fromLaunchd) {
          console.log(`Run complete. Log: ${logPath}`);
        }
        process.exit(exitCode);
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 2: Type-check and run all tests**

```bash
bun run typecheck
bun test src/
```

Expected: typecheck passes; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): implement schedule run"
```

---

## Task 20: End-to-end smoke test

This is a manual verification pass. No commits (unless issues are found and fixed).

- [ ] **Step 1: Prepare a scratch folder**

```bash
mkdir -p /tmp/agentio-schedule-smoke
cd /tmp/agentio-schedule-smoke
```

- [ ] **Step 2: Create a schedule non-interactively**

```bash
bun --cwd /Users/plosson/devel/projects/personal/agentio run dev \
  schedule add prompts/hello.run.md \
  --folder /tmp/agentio-schedule-smoke \
  --schedule interval --interval 1h --model sonnet --permission-mode bypass -y
```

Expected output: `Installed schedule "hello" in /tmp/agentio-schedule-smoke`.

Verify:

```bash
cat /tmp/agentio-schedule-smoke/prompts/hello.run.md
ls ~/Library/LaunchAgents/me.agentio.schedule.*hello*
launchctl list | grep me.agentio.schedule
```

All three should show the expected results.

- [ ] **Step 3: List schedules**

```bash
bun --cwd /Users/plosson/devel/projects/personal/agentio run dev schedule list
```

Expected: one row with `/tmp/agentio-schedule-smoke`, id `hello`, schedule `Every 1h`.

- [ ] **Step 4: Show and sync**

```bash
bun --cwd /Users/plosson/devel/projects/personal/agentio run dev schedule show hello --folder /tmp/agentio-schedule-smoke
bun --cwd /Users/plosson/devel/projects/personal/agentio run dev schedule sync --folder /tmp/agentio-schedule-smoke
```

Expected: `show` prints the config + next 5 run times. `sync` is a no-op (already in sync).

- [ ] **Step 5: Run manually**

Edit the prompt body in `/tmp/agentio-schedule-smoke/prompts/hello.run.md` to: `What is 2+2? Reply with just the number.`

```bash
bun --cwd /Users/plosson/devel/projects/personal/agentio run dev schedule run hello --folder /tmp/agentio-schedule-smoke
```

Expected: claude runs, prints `4` (or similar), exits with code 0. A log file appears in `/tmp/agentio-schedule-smoke/.agentio/runs/hello/<timestamp>.log` ending with a JSON summary line.

```bash
bun --cwd /Users/plosson/devel/projects/personal/agentio run dev schedule runs hello --folder /tmp/agentio-schedule-smoke
```

Expected: one entry shown with `status=succeeded exit=0`.

- [ ] **Step 6: Remove**

```bash
bun --cwd /Users/plosson/devel/projects/personal/agentio run dev schedule remove hello --folder /tmp/agentio-schedule-smoke
ls ~/Library/LaunchAgents/me.agentio.schedule.*hello* 2>&1 | head -3
```

Expected: plist is gone; `.run.md` file is deleted.

- [ ] **Step 7: Clean up**

```bash
rm -rf /tmp/agentio-schedule-smoke
```

---

## Task 21: Claude skill documentation

**Files:**
- Create: `claude/skills/agentio-schedule/SKILL.md`

- [ ] **Step 1: Write the skill file**

```markdown
---
name: agentio-schedule
description: Use when scheduling Claude Code prompts to run on a cron-like schedule locally via launchd. Add, list, run, and reconcile per-folder *.run.md files.
---

# Scheduling Claude Prompts with agentio

Use `agentio schedule` to run prompts on a schedule. Each schedule is a `<id>.run.md` file with YAML frontmatter + a prompt body.

## Add a schedule (non-interactive)

```bash
agentio schedule add prompts/mytask.run.md \
  --schedule daily --at 21:00 \
  --model sonnet --permission-mode bypass -y
```

Schedule types: `manual | daily | weekly | monthly | interval`.

Required flags:

| type | flags |
|------|-------|
| `daily` | `--at HH:MM` |
| `weekly` | `--weekdays mon,wed,fri --at HH:MM` |
| `monthly` | `--day 15 --at HH:MM` |
| `interval` | `--interval 30m` (`2h`, `1h30m`) |
| `manual` | none |

## Run now

```bash
agentio schedule run mytask
```

Writes the log to `.agentio/runs/mytask/<ISO>.log`.

## List / show / remove

```bash
agentio schedule list                 # all schedules on this machine
agentio schedule list --folder .      # only this folder's
agentio schedule show mytask
agentio schedule remove mytask
```

## Sync after editing a file by hand

Commit `*.run.md` files to a repo. On a new machine, inside the repo:

```bash
agentio schedule sync
```

Reconciles launchd state to match the committed files.

## File format

```markdown
---
schedule:
  type: daily
  hour: 21
  minute: 0
model: sonnet
permissionMode: bypassPermissions
sessionMode: new
enabled: true
---

Your prompt text here. Everything below the `---` is sent to claude as-is.
```

Setting `enabled: false` pauses the schedule without deleting the file. `sessionMode: resume` continues the previous session on the next run.
```

- [ ] **Step 2: Commit**

```bash
git add claude/skills/agentio-schedule/SKILL.md
git commit -m "docs(schedule): add claude skill"
```

---

## Self-review notes

- **Spec coverage:** All storage (`.run.md`, plist, state.json, runs/, .gitignore), all commands (add/list/sync/remove/run/show/runs), claude invocation, command override, frontmatter with every field, launchd trigger mapping (including Sun=7→0), stream-json session capture, broken/orphan handling, TTY fallback — each is mapped to a task above.
- **No placeholders:** every step has actual code or an exact command with expected output.
- **Types consistency:** `FrontmatterConfig`, `Schedule`, `ScheduleType`, `PermissionMode`, `SessionMode`, `Model`, `ScheduleState`, `StateFile` are defined once in Task 1 and referenced unchanged in all later tasks. `PlistDict`, `RunFile`, `RunEntry`, `InstalledSchedule` are each defined in the task that introduces them.
- **Frequent commits:** every task ends with a commit.
