# `schedule edit` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agentio schedule edit <id>` that interactively walks the user through every frontmatter setting with the current value as default, while also accepting every flag `schedule add` supports.

**Architecture:** Extend `AddFlags` / `configFromFlags` with a new `--enable` flag (symmetric to `--disabled`). Extract `promptMissing` into a broader `promptConfig(partial, fields)` helper whose `fields` set drives which FrontmatterConfig keys get prompted — `add`/`sync` keep passing their missing-fields list (behavior unchanged); `edit` passes the full editable set. Add an `applyScheduleType(current, newType)` pure helper to drop irrelevant keys on type changes. Wire a new `edit` command in `src/commands/schedule.ts` that reuses the same post-write install/uninstall logic as `add`.

**Tech Stack:** Bun, TypeScript, Commander.js, `@inquirer/prompts`, gray-matter.

**Spec:** `docs/plans/schedule-edit.md`

---

## File Structure

- **Modify** `src/commands/schedule.ts` — add `--enable` flag, extend `configFromFlags`, refactor `promptMissing` → `promptConfig`, add `applyScheduleType`, register `edit` command.
- **Modify** `src/commands/schedule.test.ts` — add tests for `--enable` flag handling and `applyScheduleType`.
- **Modify** `CLAUDE.md` — add `schedule edit` to the commands reference.

No new files needed — the feature is small enough to live in the existing module.

---

## Task 1: Add `--enable` flag

**Files:**
- Modify: `src/commands/schedule.ts` (AddFlags interface + `configFromFlags`)
- Test: `src/commands/schedule.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/commands/schedule.test.ts` inside the `describe('configFromFlags', ...)` block:

```typescript
  test('--enable sets enabled: true', () => {
    expect(configFromFlags({ enable: true }).enabled).toBe(true);
  });
  test('--enable + --disabled together throws CliError', () => {
    expect(() => configFromFlags({ enable: true, disabled: true })).toThrow(CliError);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/commands/schedule.test.ts`
Expected: the two new tests FAIL (`enable` not on `AddFlags` type → compile error, or `enabled` is undefined).

- [ ] **Step 3: Extend `AddFlags` interface**

In `src/commands/schedule.ts`, update the interface (around line 32):

```typescript
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
  host?: string;
  disabled?: boolean;
  enable?: boolean;
  yes?: boolean;
}
```

- [ ] **Step 4: Handle `--enable` / `--disabled` in `configFromFlags`**

Replace the `if (flags.disabled) partial.enabled = false;` line inside `configFromFlags` with:

```typescript
  if (flags.disabled && flags.enable) {
    throw new CliError(
      'INVALID_PARAMS',
      '--enable and --disabled cannot be used together',
      'Pass only one'
    );
  }
  if (flags.disabled) partial.enabled = false;
  if (flags.enable) partial.enabled = true;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/commands/schedule.test.ts`
Expected: all tests PASS (existing 7 + new 2 = 9).

- [ ] **Step 6: Commit**

```bash
git add src/commands/schedule.ts src/commands/schedule.test.ts
git commit -m "feat(schedule): add --enable flag for re-enabling schedules"
```

---

## Task 2: Add pure `applyScheduleType` helper

**Why:** When the user changes the schedule type in the walk-through (e.g. weekly → daily), fields that don't apply to the new type (e.g. `weekdays`) must be dropped. A pure helper keeps this testable.

**Files:**
- Modify: `src/commands/schedule.ts` (new export near `scheduleFromFlags`)
- Test: `src/commands/schedule.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/commands/schedule.test.ts`:

```typescript
import { applyScheduleType } from './schedule';

describe('applyScheduleType', () => {
  test('weekly -> daily drops weekdays, keeps hour/minute', () => {
    expect(applyScheduleType(
      { type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] },
      'daily'
    )).toEqual({ type: 'daily', hour: 9, minute: 0 });
  });
  test('daily -> interval drops hour/minute', () => {
    expect(applyScheduleType(
      { type: 'daily', hour: 9, minute: 0 },
      'interval'
    )).toEqual({ type: 'interval' });
  });
  test('daily -> monthly keeps hour/minute, no day', () => {
    expect(applyScheduleType(
      { type: 'daily', hour: 9, minute: 30 },
      'monthly'
    )).toEqual({ type: 'monthly', hour: 9, minute: 30 });
  });
  test('interval -> manual drops intervalMinutes', () => {
    expect(applyScheduleType(
      { type: 'interval', intervalMinutes: 30 },
      'manual'
    )).toEqual({ type: 'manual' });
  });
  test('same type is a no-op', () => {
    const s: Schedule = { type: 'weekly', hour: 9, minute: 0, weekdays: [2] };
    expect(applyScheduleType(s, 'weekly')).toEqual(s);
  });
});
```

Add the `Schedule` type import at the top of the test file:

```typescript
import type { Schedule } from '../types/schedule';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/commands/schedule.test.ts`
Expected: compile error — `applyScheduleType` not exported.

- [ ] **Step 3: Implement `applyScheduleType`**

In `src/commands/schedule.ts`, add right after `scheduleFromFlags`:

```typescript
/**
 * Rebuild a Schedule for a new type, carrying over fields that still apply
 * and dropping irrelevant ones.
 */
export function applyScheduleType(current: Schedule, newType: ScheduleType): Schedule {
  switch (newType) {
    case 'manual':
      return { type: 'manual' };
    case 'daily':
      return {
        type: 'daily',
        ...(current.hour !== undefined ? { hour: current.hour } : {}),
        ...(current.minute !== undefined ? { minute: current.minute } : {}),
      };
    case 'weekly':
      return {
        type: 'weekly',
        ...(current.hour !== undefined ? { hour: current.hour } : {}),
        ...(current.minute !== undefined ? { minute: current.minute } : {}),
        ...(current.weekdays ? { weekdays: current.weekdays } : {}),
      };
    case 'monthly':
      return {
        type: 'monthly',
        ...(current.hour !== undefined ? { hour: current.hour } : {}),
        ...(current.minute !== undefined ? { minute: current.minute } : {}),
        ...(current.day !== undefined ? { day: current.day } : {}),
      };
    case 'interval':
      return {
        type: 'interval',
        ...(current.intervalMinutes !== undefined ? { intervalMinutes: current.intervalMinutes } : {}),
      };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/commands/schedule.test.ts`
Expected: all tests PASS (9 + 5 = 14).

- [ ] **Step 5: Commit**

```bash
git add src/commands/schedule.ts src/commands/schedule.test.ts
git commit -m "feat(schedule): add applyScheduleType helper for type-change handling"
```

---

## Task 3: Refactor `promptMissing` → `promptConfig(partial, fields)`

**Why:** `edit` needs to prompt for every FrontmatterConfig field (not just schedule sub-fields). The existing `promptMissing` already has a field-driven dispatch for schedule sub-fields; generalize its input to a `Set<FieldName>` covering all editable keys. `add`/`sync` keep their current behavior by passing only the fields they need.

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Define the field-name type and function signature**

Add near the top of `src/commands/schedule.ts` (after the `VALID_*` constants):

```typescript
export type ConfigField =
  | 'schedule'
  | 'weekdays'
  | 'day'
  | 'hour'
  | 'minute'
  | 'intervalMinutes'
  | 'model'
  | 'permissionMode'
  | 'sessionMode'
  | 'command'
  | 'host'
  | 'enabled';

export const SCHEDULE_FIELDS: readonly ConfigField[] = [
  'schedule', 'weekdays', 'day', 'hour', 'minute', 'intervalMinutes',
];

export const ALL_EDITABLE_FIELDS: readonly ConfigField[] = [
  'schedule', 'weekdays', 'day', 'hour', 'minute', 'intervalMinutes',
  'model', 'permissionMode', 'sessionMode', 'command', 'host', 'enabled',
];
```

- [ ] **Step 2: Rewrite `promptMissing` as `promptConfig`**

Replace the existing `promptMissing` function body with this (keep the function name change in mind — callers will be updated in Step 3):

```typescript
async function promptConfig(
  partial: Partial<FrontmatterConfig>,
  fields: readonly ConfigField[]
): Promise<Partial<FrontmatterConfig>> {
  const fieldSet = new Set(fields);
  const out: Partial<FrontmatterConfig> = { ...partial };
  let s: Schedule = { ...(out.schedule ?? { type: 'manual' }) } as Schedule;

  if (fieldSet.has('schedule')) {
    const newType = await select({
      message: 'Schedule type:',
      choices: VALID_SCHEDULE_TYPES.map((t) => ({ name: t, value: t })),
      default: s.type,
    });
    s = applyScheduleType(s, newType);
  }

  // Schedule sub-fields are only prompted when relevant for the current type.
  const needsHM = s.type === 'daily' || s.type === 'weekly' || s.type === 'monthly';
  const needsWeekdays = s.type === 'weekly';
  const needsDay = s.type === 'monthly';
  const needsInterval = s.type === 'interval';

  if (needsWeekdays && fieldSet.has('weekdays')) {
    const current = s.weekdays ? s.weekdays.map(String).join(',') : '';
    const raw = await input({ message: 'Weekdays (e.g. mon,wed,fri):', default: current });
    s.weekdays = parseWeekdays(raw);
  }
  if (needsDay && fieldSet.has('day')) {
    const current = s.day !== undefined ? String(s.day) : '';
    const raw = await input({ message: 'Day of month (1-31):', default: current });
    s.day = parseInt(raw, 10);
  }
  if (needsHM && (fieldSet.has('hour') || fieldSet.has('minute'))) {
    const hDef = s.hour !== undefined ? String(s.hour).padStart(2, '0') : '09';
    const mDef = s.minute !== undefined ? String(s.minute).padStart(2, '0') : '00';
    const raw = await input({ message: 'Time of day (HH:MM):', default: `${hDef}:${mDef}` });
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) throw new CliError('INVALID_PARAMS', `Invalid time: "${raw}"`, 'Expected HH:MM');
    s.hour = parseInt(m[1], 10);
    s.minute = parseInt(m[2], 10);
  }
  if (needsInterval && fieldSet.has('intervalMinutes')) {
    const currentMinutes = s.intervalMinutes ?? 0;
    const hh = Math.floor(currentMinutes / 60);
    const mm = currentMinutes % 60;
    const currentDur = hh > 0 && mm > 0 ? `${hh}h${mm}m` : hh > 0 ? `${hh}h` : `${mm}m`;
    const raw = await input({
      message: 'Interval (e.g. 30m, 2h, 1h30m):',
      default: currentMinutes > 0 ? currentDur : '30m',
    });
    s.intervalMinutes = parseDuration(raw);
  }
  out.schedule = s;

  if (fieldSet.has('model')) {
    out.model = await select({
      message: 'Model:',
      choices: VALID_MODELS.map((m) => ({ name: m, value: m })),
      default: out.model ?? 'sonnet',
    });
  }
  if (fieldSet.has('permissionMode')) {
    out.permissionMode = await select({
      message: 'Permission mode:',
      choices: VALID_PERMISSION_MODES.map((m) => ({ name: m, value: m })),
      default: out.permissionMode ?? 'bypassPermissions',
    });
  }
  if (fieldSet.has('sessionMode')) {
    out.sessionMode = await select({
      message: 'Session mode:',
      choices: VALID_SESSION_MODES.map((m) => ({ name: m, value: m })),
      default: out.sessionMode ?? 'new',
    });
  }
  if (fieldSet.has('command')) {
    const raw = await input({
      message: 'Command override (empty to clear):',
      default: out.command ?? '',
    });
    if (raw.trim()) out.command = raw.trim();
    else delete out.command;
  }
  if (fieldSet.has('host')) {
    const raw = await input({
      message: 'Pin to host (empty to clear):',
      default: out.host ?? '',
    });
    if (raw.trim()) out.host = raw.trim();
    else delete out.host;
  }
  if (fieldSet.has('enabled')) {
    const enabled = await select({
      message: 'Enabled?',
      choices: [
        { name: 'yes', value: true },
        { name: 'no', value: false },
      ],
      default: out.enabled ?? true,
    });
    out.enabled = enabled;
  }

  return out;
}
```

- [ ] **Step 3: Update existing callers (`add` action and `sync` action)**

In the `add` command's action, replace:

```typescript
          merged = await promptMissing(merged, missing);
```

with:

```typescript
          merged = await promptConfig(merged, missing as ConfigField[]);
```

In the `sync` command's action, replace:

```typescript
            config = await promptMissing(config, missing);
```

with:

```typescript
            config = await promptConfig(config, missing as ConfigField[]);
```

- [ ] **Step 4: Verify everything still compiles and existing tests pass**

Run: `bun run typecheck`
Expected: no errors.

Run: `bun test src/commands/schedule.test.ts`
Expected: 14 tests PASS (from Tasks 1 + 2).

- [ ] **Step 5: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): generalize promptMissing into promptConfig"
```

---

## Task 4: Register the `edit` command

**Files:**
- Modify: `src/commands/schedule.ts` — register the new subcommand.

- [ ] **Step 1: Add the `edit` subcommand registration**

Inside `registerScheduleCommands`, add after the `add` command registration (before `schedule.command('list')`):

```typescript
  schedule.command('edit').description('Edit an existing schedule (walk-through editor)')
    .argument('<id>', 'Schedule id')
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
    .option('--host <name>', 'Pin schedule to a specific hostname; skipped on other machines')
    .option('--disabled', 'Set enabled: false')
    .option('--enable', 'Set enabled: true')
    .option('-y, --yes', 'Non-interactive; apply flags only, error if required fields missing')
    .action(async (id: string, opts: AddFlags) => {
      try {
        const folder = opts.folder ? resolve(opts.folder) : process.cwd();
        const matches = walkRunFiles(folder).filter((f) => f.id === id);
        if (matches.length === 0) {
          throw new CliError('NOT_FOUND', `No .run.md file found for id "${id}" under ${folder}`,
            'Check the id (agentio schedule list) or pass --folder');
        }
        if (matches.length > 1) {
          throw new CliError('INVALID_PARAMS',
            `Multiple files match id "${id}": ${matches.map((m) => m.path).join(', ')}`);
        }
        const filePath = matches[0].path;

        const raw = await readFile(filePath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        const existingConfig: Partial<FrontmatterConfig> = parsed.config;

        const override = configFromFlags(opts);
        let merged: Partial<FrontmatterConfig> = {
          ...existingConfig,
          ...override,
          ...(override.schedule
            ? { schedule: override.schedule }
            : existingConfig.schedule
            ? { schedule: existingConfig.schedule }
            : {}),
        };

        if (opts.yes || !isInteractive()) {
          const missing = missingScheduleFields(merged.schedule);
          if (missing.length > 0) {
            throw new CliError('INVALID_PARAMS',
              `Missing required fields: ${missing.join(', ')}`,
              'Provide via flags or run interactively (no -y)');
          }
        } else {
          merged = await promptConfig(merged, ALL_EDITABLE_FIELDS);
        }

        const finalConfig: FrontmatterConfig = mergeConfig({}, merged);

        await writeFile(filePath, serializeFrontmatter(finalConfig, parsed.body || '# TODO\n'));

        if (hostMatches(finalConfig)) {
          installPlist(folder, id, finalConfig);
          console.log(`Updated schedule "${id}" in ${folder}`);
        } else {
          uninstallPlist(folder, id);
          console.log(`Wrote "${id}" (pinned to host "${finalConfig.host}"; current host is "${getCurrentHost()}"; plist not installed)`);
        }
      } catch (e) {
        handleError(e);
      }
    });
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-test the command help**

Run: `bun run dev schedule edit --help`
Expected: prints the command description and all flags listed above.

- [ ] **Step 4: Smoke-test `-y` flag-only edit on a scratch file**

Create a scratch schedule and edit it non-interactively. Note: because `scheduleFromFlags` treats `--schedule` as the trigger for building a Schedule from flags (same as `add`), passing `--schedule <type>` alongside the sub-field flags is required for flag-only edits of schedule sub-fields:

```bash
mkdir -p /tmp/agentio-edit-test
bun run dev schedule add /tmp/agentio-edit-test/foo.run.md --schedule daily --at 09:00 -y
bun run dev schedule edit foo --folder /tmp/agentio-edit-test --schedule daily --at 10:30 -y
```

Expected: the second command prints `Updated schedule "foo" in /tmp/agentio-edit-test`, and the file's frontmatter now has `hour: 10, minute: 30`.

Verify by reading:

```bash
cat /tmp/agentio-edit-test/foo.run.md
```

Expected: `hour: 10` and `minute: 30` appear in the frontmatter.

Clean up:

```bash
bun run dev schedule remove foo --folder /tmp/agentio-edit-test
rm -rf /tmp/agentio-edit-test
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): add edit subcommand with interactive walk-through"
```

---

## Task 5: Update CLAUDE.md command reference

**Files:**
- Modify: `CLAUDE.md` (the project-level instructions checked into the repo)

- [ ] **Step 1: Locate the schedule section**

The schedule command reference isn't currently in the CLAUDE.md Commands Reference list (search the file for `schedule`). Since the rest of the schedule commands also aren't listed there, and the user's intent is feature addition not documentation cleanup, check whether the repo has a dedicated schedule docs file instead.

Run: `grep -n "schedule" CLAUDE.md | head -20`

If schedule is not documented in CLAUDE.md, **skip this task**. Otherwise, add a line describing `edit`:

```
agentio schedule edit <id> [--schedule ...] [--at ...] [...] [-y]
```

- [ ] **Step 2: Commit (only if changes were made)**

```bash
git add CLAUDE.md
git commit -m "docs: document schedule edit command"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full test suite**

Run: `bun test`
Expected: all tests PASS.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual interactive smoke test**

```bash
mkdir -p /tmp/agentio-edit-test
bun run dev schedule add /tmp/agentio-edit-test/bar.run.md --schedule weekly --at 09:00 --weekdays mon,fri -y
bun run dev schedule edit bar --folder /tmp/agentio-edit-test
```

Expected: the walk-through prompts for every field with the current value as default. Confirm changing:
- `schedule type` weekly → daily → the next prompt should ask HH:MM (not weekdays).
- Pressing Enter at every prompt after that keeps existing values.

After completing, verify the file has `type: daily` and no `weekdays` key:

```bash
cat /tmp/agentio-edit-test/bar.run.md
```

Clean up:

```bash
bun run dev schedule remove bar --folder /tmp/agentio-edit-test
rm -rf /tmp/agentio-edit-test
```
