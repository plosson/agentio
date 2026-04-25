# CLI UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agentio CLI more discoverable, consistent, and forgiving — addressing 11 specific friction points in command organization, error messages, empty-state guidance, and help output.

**Architecture:** Mostly small, surgical edits across `src/commands/*` and `src/index.ts`, plus two new commands (`doctor`, unified `profile`) and one new utility (custom Commander help formatter). Each phase ships independently; the user can ship any subset.

**Tech Stack:** Bun, TypeScript, Commander.js (custom `configureHelp`), `bun:test`.

**Phasing (each phase is independently shippable):**
- **A — Quick wins** (Tasks 1-4): error message tweaks, hide deprecated `gateway`, description sweep, empty-state audit
- **B — Schedule polish** (Tasks 5-9): rename `runs`→`history`, `sync`→`check`, fold `watched` into `list`, hide `migrate`, symmetric `add`/`remove`
- **C — Grouped help** (Tasks 10-11): custom Commander help formatter, hide low-frequency top-level commands
- **D — Auto-magic flows** (Tasks 12-14): vault-locked → setup hint, post-setup nudge, auto-start daemon when needed
- **E — Doctor command** (Task 15): unified health check
- **F — Unified profile namespace** (Task 16): `agentio profile <verb> <service>`

---

## File Structure

### New files
- `src/utils/help-formatter.ts` — custom Commander help formatter that groups commands into sections
- `src/utils/help-formatter.test.ts`
- `src/commands/doctor.ts` — `agentio doctor` health check
- `src/commands/doctor.test.ts`
- `src/commands/profile.ts` — unified `agentio profile <verb> <service>` namespace (Phase F)
- `src/commands/profile.test.ts`

### Modified files
- `src/index.ts` — apply help formatter; hide deprecated `gateway` + low-freq commands; register `doctor`, `profile`
- `src/config/config-manager.ts` — return profile names with `'multiple'` error result
- `src/commands/schedule.ts` — rename subcommands, fold `watched` into `list`, hide `migrate`, symmetric `add`/`remove`
- `src/commands/setup.ts` — post-setup nudge
- `src/vault/vault.ts` — friendlier `VAULT_LOCKED` message
- `src/commands/daemon.ts` — `daemon ensure-running()` helper for auto-start
- `src/commands/whatsapp.ts`, `src/commands/telegram.ts` — multi-profile error includes names; auto-start daemon hooks
- `src/commands/status.ts` — empty-state guidance
- `src/utils/errors.ts` — multi-profile error helper

---

## Task 1: Multi-profile error message includes available names

**Files:**
- Modify: `src/config/config-manager.ts` (extend `resolveProfile` return)
- Modify: every callsite of `resolveProfile` that throws `'Multiple profiles exist. Use --profile to specify one.'` (all of `src/commands/whatsapp.ts`, `src/commands/telegram.ts`)
- Test: `src/config/config-manager.test.ts` (extend existing)

- [ ] **Step 1: Read current `resolveProfile` signature and the multi-profile error sites**

```bash
grep -n "resolveProfile" src/config/config-manager.ts
grep -n "Multiple profiles exist" src/commands/*.ts
```

Expected: `resolveProfile` returns `{ profile, readOnly?, error? }` where `error` is `'none' | 'multiple'`. ~12 callsites throw the same error string.

- [ ] **Step 2: Write failing test**

Add to `src/config/config-manager.test.ts`:

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { resolveProfile, setProfile } from './config-manager';

describe('resolveProfile multi-profile case', () => {
  test('returns names array when multiple profiles exist and none specified', async () => {
    // Test setup needs vault context — adapt to whatever the file already does
    await setProfile('whatsapp', 'work');
    await setProfile('whatsapp', 'personal');
    const r = await resolveProfile('whatsapp');
    expect(r.error).toBe('multiple');
    expect(r.names).toEqual(['work', 'personal']);
  });
});
```

If the existing test file already has setup helpers, reuse them. If not, mirror the pattern from `src/vault/vault.test.ts` (uses `tempHome` + `AGENTIO_PASSPHRASE_STORE=memory:...` env var).

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/config/config-manager.test.ts -t "names array when multiple"
```

Expected: FAIL — `r.names` is `undefined`.

- [ ] **Step 4: Implement**

In `src/config/config-manager.ts`, change the `resolveProfile` return type and the `'multiple'` branch:

```ts
export async function resolveProfile(
  service: ServiceName,
  profileName?: string
): Promise<{ profile: string | null; readOnly?: boolean; error?: 'none' | 'multiple'; names?: string[] }> {
  // ... existing body unchanged until the multiple branch ...

  // Multiple profiles exist - user must specify
  return {
    profile: null,
    error: 'multiple',
    names: serviceProfiles.map(getProfileName),
  };
}
```

- [ ] **Step 5: Add a helper that formats the error**

In `src/utils/errors.ts`, add:

```ts
import type { ServiceName } from '../types/config';

export function multipleProfilesError(service: ServiceName, names: string[]): CliError {
  const list = names.join(', ');
  return new CliError(
    'INVALID_PARAMS',
    `Multiple ${service} profiles exist: ${list}.`,
    `Use --profile <name> to pick one.`,
  );
}
```

- [ ] **Step 6: Replace all error sites**

In every `src/commands/*.ts` file with `throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.')`, replace with:

```ts
throw multipleProfilesError(<SERVICE_NAME_LITERAL>, profileResult.names ?? []);
```

Add `import { multipleProfilesError } from '../utils/errors'` to each modified file.

Use this command to find all sites:
```bash
grep -rn "Multiple profiles exist. Use --profile to specify one." src/commands
```

- [ ] **Step 7: Run tests**

```bash
bun run typecheck && bun test
```

Expected: PASS, including the new multi-profile test.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): list available profile names in multi-profile error"
```

---

## Task 2: Hide deprecated `gateway` from main `--help`

**Files:**
- Modify: `src/commands/daemon.ts` (the `registerDaemonCommands` function — pass a `hidden` flag through)

- [ ] **Step 1: Read current registration**

```bash
grep -n "deprecated.*gateway\|registerDaemonCommands" src/commands/daemon.ts src/index.ts
```

You'll find that `registerDaemonCommands(program, { base: 'gateway', deprecated: true })` is called once. Today that call produces a `gateway` top-level command WITHOUT `hidden: true`.

- [ ] **Step 2: Pass `hidden` through to Commander**

In `src/commands/daemon.ts`, find the line that creates the command:

```ts
const daemon = program
  .command(baseName)
  .description(description);
```

Replace with:

```ts
const daemon = program
  .command(baseName, opts.deprecated ? { hidden: true } : {})
  .description(description);
```

- [ ] **Step 3: Verify**

```bash
bun run dev --help 2>&1 | grep -E "^  (daemon|gateway)"
bun run dev gateway --help 2>&1 | head -5
```

Expected:
- `daemon` shown in main help
- `gateway` NOT shown in main help
- `gateway --help` still works and shows `[deprecated] alias of \`agentio daemon\``

- [ ] **Step 4: Commit**

```bash
git add src/commands/daemon.ts
git commit -m "chore(cli): hide deprecated \`gateway\` alias from main help"
```

---

## Task 3: Service description consistency sweep

**Files:**
- Modify: `src/commands/whatsapp.ts`, `src/commands/telegram.ts`, `src/commands/slack.ts`, `src/commands/gmail.ts`, etc. — anywhere a service top-level `.description()` mentions or fails to mention daemon dependency

- [ ] **Step 1: Audit current state**

```bash
grep -n "\\.description('" src/commands/*.ts | grep -E "(operations|profile|inbox|outbox)" | head -30
```

Result will show inconsistent descriptors. Today: `whatsapp` says "WhatsApp operations (requires daemon)"; `telegram` says "Telegram operations" (no annotation despite having daemon-backed inbox/outbox); `slack` says "Slack operations" (no inbox today, so consistent).

- [ ] **Step 2: Adopt one rule and apply**

Rule: **drop the parenthetical annotation entirely on the service top-level**, since most subcommands work without the daemon (`send`, `profile`, etc.). Daemon dependency is annotated on the `inbox`/`outbox`/`group` subcommand groups only.

In `src/commands/whatsapp.ts`, change:
```ts
.description('WhatsApp operations (requires daemon)');
```
to:
```ts
.description('WhatsApp operations');
```

The `inbox`/`outbox`/`group` subcommand-group `.description()` strings keep their `(requires daemon)` annotation.

For `src/commands/telegram.ts`, the top-level is already "Telegram operations" — leave as-is. Verify the `inbox`/`outbox` subcommand groups have `(requires daemon)` annotations for parity with WhatsApp; add if missing.

- [ ] **Step 3: Verify**

```bash
bun run dev --help 2>&1 | grep -E "^  (whatsapp|telegram|slack)"
```

Expected: all three look consistent — no parenthetical on top-level service descriptions.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(cli): consistent service description style"
```

---

## Task 4: Empty-state guidance audit

**Files:**
- Modify: `src/commands/status.ts`, plus any `*Profile list` or `<service> list` action that prints "No X" without a follow-up command suggestion

- [ ] **Step 1: Inventory empty-state branches**

```bash
grep -rn "No .* configured\|No .* found\|No .* set" src/commands/*.ts | grep -v test
```

You'll see ~10–15 places that print things like "No WhatsApp profiles configured" or "No schedules.". Audit each: does it tell the user how to create one?

- [ ] **Step 2: Define the pattern**

Empty-state messages should have two lines:
1. What's missing
2. The exact command that fixes it

Example (already correct in `schedule watched`):
```
No folders watched.
Add one with: agentio schedule watch <folder>
```

- [ ] **Step 3: Apply to each site**

For each grep hit, update to follow the pattern. Concrete examples to fix:

`src/commands/whatsapp.ts` `profile list` action:
```ts
if (profiles.length === 0) {
  console.log('No WhatsApp profiles configured');
  console.log('Run: agentio whatsapp profile add');
  return;
}
```
✓ Already correct.

`src/commands/status.ts` — when no profiles exist for any service, the output is currently a sequence of empty service blocks. Add a header check at the top:

```ts
const allEmpty = result.every((r) => r.profiles.length === 0);
if (allEmpty) {
  console.log('No profiles configured.');
  console.log('Add one with: agentio <service> profile add (e.g. gmail, slack, whatsapp)');
  return;
}
```

(Apply only to the human-readable branch, not `--json`.)

For each command discovered in step 1, decide whether the existing message needs a "next command" line. If yes, add it. If the message already has one, leave alone.

- [ ] **Step 4: Verify by smoke test on a fresh vault**

```bash
# In a tmpdir with AGENTIO_PASSPHRASE_STORE=memory:/tmp/x
bun run dev status
bun run dev whatsapp profile list
bun run dev schedule list
bun run dev schedule watched
```

Each should print a clear "what's missing + how to fix" message.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cli): consistent empty-state guidance with next-command hints"
```

---

## Task 5: Rename `schedule runs` → `schedule history`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Read current `runs` command**

```bash
grep -n "schedule.command('runs')" src/commands/schedule.ts
```

- [ ] **Step 2: Rename and add deprecated alias**

Find the block:
```ts
schedule.command('runs').description('List past runs for a schedule')
  .argument('<id>', 'Schedule id')
  .option('--folder <path>', 'Folder (default: CWD)')
  .action(async (id: string, opts: { folder?: string }) => { ... });
```

Replace with:
```ts
const historyAction = async (id: string, opts: { folder?: string }) => {
  // ... existing action body unchanged
};

schedule.command('history')
  .description('List past runs for a schedule')
  .argument('<id>', 'Schedule id')
  .option('--folder <path>', 'Folder (default: CWD)')
  .action(historyAction);

schedule.command('runs', { hidden: true })
  .description('[deprecated] alias of `history`')
  .argument('<id>', 'Schedule id')
  .option('--folder <path>', 'Folder (default: CWD)')
  .action(async (id: string, opts: { folder?: string }) => {
    console.error('warning: `agentio schedule runs` is deprecated; use `schedule history`.');
    await historyAction(id, opts);
  });
```

- [ ] **Step 3: Verify**

```bash
bun run dev schedule --help 2>&1 | grep -E "(history|runs)"
bun run dev schedule history --help
bun run dev schedule runs --help
```

Expected:
- `history` shown in main schedule help
- `runs` not shown
- both work; `runs` prints deprecation warning to stderr

- [ ] **Step 4: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): rename \`runs\` to \`history\` (alias kept)"
```

---

## Task 6: Rename `schedule sync` → `schedule check`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Apply the same alias pattern as Task 5**

Extract the existing `sync` action into a named function, register `check` as the canonical command, register `sync` as a hidden alias with a deprecation warning.

```ts
const checkAction = async (opts: { folder?: string; yes?: boolean }) => {
  // ... existing sync action body unchanged
};

schedule.command('check')
  .description('Validate .run.md files in a folder (id collisions, missing frontmatter, .gitignore scaffolding)')
  .option('--folder <path>', 'Folder to check (default: CWD)')
  .option('-y, --yes', 'Non-interactive')
  .action(checkAction);

schedule.command('sync', { hidden: true })
  .description('[deprecated] alias of `check`')
  .option('--folder <path>', 'Folder to check (default: CWD)')
  .option('-y, --yes', 'Non-interactive')
  .action(async (opts) => {
    console.error('warning: `agentio schedule sync` is deprecated; use `schedule check`.');
    await checkAction(opts);
  });
```

- [ ] **Step 2: Verify**

```bash
bun run dev schedule --help 2>&1 | grep -E "(check|sync)"
```

Expected: `check` listed; `sync` not.

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): rename \`sync\` to \`check\` (alias kept)"
```

---

## Task 7: Fold `schedule watched` into `schedule list --folders`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Add `--folders` flag to `list`**

In `src/commands/schedule.ts`, find the `list` command. Add an option:

```ts
.option('--folders', 'Show watched folders instead of schedules')
```

In the action handler, branch at the top:

```ts
if (opts.folders) {
  const config = await loadConfig();
  const folders = config.daemon?.scheduler?.watchedFolders ?? [];
  if (folders.length === 0) {
    console.log('No folders watched.');
    console.log('Add one with: agentio schedule watch <folder>');
    return;
  }
  for (const f of folders) {
    const pin = f.host ? ` (pinned to ${f.host})` : '';
    console.log(`${abbrHome(f.path)}${pin}`);
  }
  return;
}
// ... existing list-schedules body unchanged
```

- [ ] **Step 2: Convert `watched` to deprecated alias**

Same alias pattern as previous tasks:

```ts
schedule.command('watched', { hidden: true })
  .description('[deprecated] alias of `list --folders`')
  .action(async () => {
    console.error('warning: `agentio schedule watched` is deprecated; use `schedule list --folders`.');
    // Inline the same body as the --folders branch above, OR factor both into a shared helper
  });
```

Best to factor: extract a `listFolders()` helper and call it from both places.

- [ ] **Step 3: Verify**

```bash
bun run dev schedule list --folders
bun run dev schedule watched
bun run dev schedule --help 2>&1 | grep -E "(list|watched)"
```

Expected: both work; only `list` shown in main help.

- [ ] **Step 4: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): fold \`watched\` into \`list --folders\`"
```

---

## Task 8: Hide `schedule migrate`, surface via daemon detection

**Files:**
- Modify: `src/commands/schedule.ts` — hide migrate
- Modify: `src/daemon/daemon.ts` — detect legacy plists at startup, log a hint

- [ ] **Step 1: Hide `migrate` from main help**

In `src/commands/schedule.ts`, change:
```ts
schedule.command('migrate').description('Remove legacy per-schedule launchd plists ...')
```
to:
```ts
schedule.command('migrate', { hidden: true }).description('Remove legacy per-schedule launchd plists ...')
```

- [ ] **Step 2: Add startup detection in the daemon**

In `src/daemon/daemon.ts`, inside `startDaemon()` after `migrateLegacyFiles(CONFIG_DIR)`, add:

```ts
if (process.platform === 'darwin') {
  try {
    const launchAgentsDir = join(homedir(), 'Library', 'LaunchAgents');
    if (existsSync(launchAgentsDir)) {
      const legacy = (await import('fs')).readdirSync(launchAgentsDir)
        .filter((f) => f.startsWith('me.agentio.schedule.') && f.endsWith('.plist'));
      if (legacy.length > 0) {
        console.log(`[migration] Found ${legacy.length} legacy schedule plist(s).`);
        console.log('[migration] Run: agentio schedule migrate');
      }
    }
  } catch { /* non-fatal */ }
}
```

Add the missing imports (`homedir`, `existsSync`, `join`) at the top of `daemon.ts` if not already present.

- [ ] **Step 3: Verify**

```bash
bun run dev schedule --help 2>&1 | grep migrate
```

Expected: `migrate` not shown.

```bash
bun run dev schedule migrate --help
```

Expected: still works (just hidden from listing).

- [ ] **Step 4: Commit**

```bash
git add src/commands/schedule.ts src/daemon/daemon.ts
git commit -m "chore(schedule): hide \`migrate\`, daemon flags legacy plists at startup"
```

---

## Task 9: Symmetric `schedule add`/`remove` arg shapes

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Decide on the shape**

Both commands accept either:
- A path ending in `.run.md` (interpreted as the file directly)
- A bare id (interpreted as `<cwd>/<id>.run.md` for `add`; located via `walkRunFiles(folder)` for `remove`)

Today: `add <file>` requires path; `remove <id>` requires id.

- [ ] **Step 2: Update `add` to accept either**

In the `add` action, replace:

```ts
const filePath = isAbsolute(file) ? file : resolve(folder, file);
```

with:

```ts
let filePath: string;
if (file.endsWith('.run.md')) {
  filePath = isAbsolute(file) ? file : resolve(folder, file);
} else {
  // Treat as id
  filePath = resolve(folder, `${file}.run.md`);
}
```

Remove the early validation `if (!file.endsWith('.run.md')) throw ...`.

Update the argument description:
```ts
.argument('<file-or-id>', 'Path to a .run.md file, or a bare id (creates <folder>/<id>.run.md)')
```

- [ ] **Step 3: Update `remove` to accept either**

In the `remove` action, replace the start:

```ts
const matches = walkRunFiles(folder).filter((f) => f.id === id);
```

with:

```ts
let matches: ReturnType<typeof walkRunFiles>;
if (id.endsWith('.run.md')) {
  // Treat as path — relative to folder or absolute
  const filePath = isAbsolute(id) ? id : resolve(folder, id);
  if (!existsSync(filePath)) {
    throw new CliError('NOT_FOUND', `No file at ${filePath}`);
  }
  const idFromPath = (await import('path')).basename(filePath).slice(0, -'.run.md'.length);
  matches = [{ path: filePath, id: idFromPath }];
} else {
  matches = walkRunFiles(folder).filter((f) => f.id === id);
}
```

Update the argument description:
```ts
.argument('<id-or-file>', 'Schedule id, or path to a .run.md file')
```

- [ ] **Step 4: Verify**

```bash
mkdir -p /tmp/sym-test && cd /tmp/sym-test
bun run dev schedule add foo --schedule manual -y      # creates foo.run.md
bun run dev schedule add bar.run.md --schedule manual -y  # creates bar.run.md
bun run dev schedule remove foo                        # works by id
bun run dev schedule remove bar.run.md                 # works by path
ls *.run.md                                             # should be empty
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): accept either id or .run.md path in \`add\` and \`remove\`"
```

---

## Task 10: Custom Commander help formatter that groups commands

**Files:**
- Create: `src/utils/help-formatter.ts`, `src/utils/help-formatter.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `src/utils/help-formatter.test.ts`:

```ts
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
    // Ungrouped commands appear after groups
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
```

- [ ] **Step 2: Run the test**

```bash
bun test src/utils/help-formatter.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `help-formatter.ts`**

Create `src/utils/help-formatter.ts`:

```ts
import type { Command } from 'commander';

export type CommandGroups = Record<string, string[]>;

/**
 * Override the program's `formatHelp` so that subcommands are grouped under
 * named section headers. Any command not listed in `groups` falls into "Other".
 * Hidden commands are skipped.
 */
export function applyGroupedHelp(program: Command, groups: CommandGroups): void {
  program.configureHelp({
    formatHelp: (cmd, helper) => {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = helper.helpWidth ?? 80;

      let output = '';

      // Usage line
      output += `Usage: ${helper.commandUsage(cmd)}\n\n`;

      // Description
      const desc = helper.commandDescription(cmd);
      if (desc) output += `${desc}\n\n`;

      // Options
      const optionList = helper.visibleOptions(cmd);
      if (optionList.length > 0) {
        output += 'Options:\n';
        for (const opt of optionList) {
          output += `  ${helper.optionTerm(opt).padEnd(termWidth)}  ${helper.optionDescription(opt)}\n`;
        }
        output += '\n';
      }

      // Group subcommands
      const allCommands = helper.visibleCommands(cmd);
      const groupedNames = new Set<string>();
      for (const list of Object.values(groups)) for (const n of list) groupedNames.add(n);

      const renderGroup = (label: string, names: string[]) => {
        const cmds = names
          .map((n) => allCommands.find((c) => c.name() === n))
          .filter((c): c is Command => !!c);
        if (cmds.length === 0) return;
        output += `${label}:\n`;
        for (const c of cmds) {
          const term = helper.subcommandTerm(c).padEnd(termWidth);
          output += `  ${term}  ${helper.subcommandDescription(c)}\n`;
        }
        output += '\n';
      };

      for (const [label, names] of Object.entries(groups)) {
        renderGroup(label, names);
      }

      const other = allCommands.filter((c) => !groupedNames.has(c.name()));
      if (other.length > 0) {
        output += 'Other:\n';
        for (const c of other) {
          const term = helper.subcommandTerm(c).padEnd(termWidth);
          output += `  ${term}  ${helper.subcommandDescription(c)}\n`;
        }
        output += '\n';
      }

      // Use helpWidth to satisfy lint if not used; otherwise drop.
      void helpWidth;
      return output.trimEnd() + '\n';
    },
  });
}
```

- [ ] **Step 4: Run the test**

```bash
bun test src/utils/help-formatter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire into `src/index.ts`**

After all `register*Commands(program)` calls but before `program.parse()`, add:

```ts
import { applyGroupedHelp } from './utils/help-formatter';

applyGroupedHelp(program, {
  'Setup': ['setup', 'status', 'doctor', 'update'],
  'Services': [
    'gmail', 'gdocs', 'gdrive', 'gcal', 'gchat', 'gtasks', 'gsheets',
    'github', 'jira', 'slack', 'telegram', 'whatsapp', 'discourse', 'rss', 'sql',
  ],
  'Automation': ['schedule', 'daemon'],
  'Advanced': ['config', 'mcp', 'server', 'profile'],
});
```

(`doctor` and `profile` are added in later tasks; that's fine — they'll be ignored by the grouper until they exist.)

- [ ] **Step 6: Verify**

```bash
bun run dev --help
```

Expected: groups appear with headers; `gateway`, `claude`, `reauth`, `docs` fall into "Other:" (until Task 11 hides them).

- [ ] **Step 7: Commit**

```bash
git add src/utils/help-formatter.ts src/utils/help-formatter.test.ts src/index.ts
git commit -m "feat(cli): grouped top-level help via custom Commander formatter"
```

---

## Task 11: Hide low-frequency top-level commands

**Files:**
- Modify: `src/commands/docs.ts`, `src/commands/claude.ts`, `src/commands/reauth.ts` — pass `{ hidden: true }` to Commander

- [ ] **Step 1: Find each registration**

```bash
grep -n "program.command\|.command('" src/commands/{docs,claude,reauth}.ts
```

- [ ] **Step 2: Add `{ hidden: true }`**

For each, change e.g.:
```ts
program.command('docs').description('...')
```
to:
```ts
program.command('docs', { hidden: true }).description('...')
```

Apply to: `docs`, `claude`, `reauth`.

(`reauth` will eventually move under `profile reauth` in Task 16; hiding it from main help now makes that transition cleaner.)

- [ ] **Step 3: Verify**

```bash
bun run dev --help
bun run dev docs --help    # still works
bun run dev claude --help  # still works
bun run dev reauth --help  # still works
```

Expected: none of those 3 appear in main help; each works when invoked directly.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(cli): hide low-frequency commands from main help (\`docs\`, \`claude\`, \`reauth\`)"
```

---

## Task 12: Friendlier `VAULT_LOCKED` / `VAULT_NOT_CONFIGURED` errors

**Files:**
- Modify: `src/vault/vault.ts`

- [ ] **Step 1: Read current errors**

```bash
grep -n "VAULT_LOCKED\|VAULT_NOT_CONFIGURED" src/vault/vault.ts
```

You'll see two `CliError` constructors with messages "Vault is locked" / "No vault configured" and a suggestion line.

- [ ] **Step 2: Tweak the error suggestions**

Change:
```ts
throw new CliError(
  'VAULT_LOCKED',
  'Vault is locked',
  'Run: agentio setup, or set AGENTIO_PASSPHRASE'
);
```
to:
```ts
throw new CliError(
  'VAULT_LOCKED',
  'Vault is locked — passphrase not found',
  'Run `agentio setup` to set the passphrase, or set the AGENTIO_PASSPHRASE env var.'
);
```

Change:
```ts
throw new CliError(
  'VAULT_NOT_CONFIGURED',
  'No vault configured',
  'Run: agentio setup'
);
```
to:
```ts
throw new CliError(
  'VAULT_NOT_CONFIGURED',
  'agentio is not configured yet',
  'Run `agentio setup` to initialize the vault.'
);
```

- [ ] **Step 3: Verify**

```bash
# In a fresh tmp HOME
HOME=/tmp/fresh-test bun run dev gmail list 2>&1 | head -5
```

Expected: friendly error pointing at `agentio setup`.

- [ ] **Step 4: Commit**

```bash
git add src/vault/vault.ts
git commit -m "polish(vault): warmer VAULT_LOCKED / VAULT_NOT_CONFIGURED messages"
```

---

## Task 13: Post-`setup` first-run nudge

**Files:**
- Modify: `src/commands/setup.ts`

- [ ] **Step 1: Find the success log lines**

```bash
grep -n "Vault created\|Adopted vault\|Passphrase changed" src/commands/setup.ts
```

`doInitialSetup`, `doMigrationSetup`, `doAdoptExisting` each end with `console.log(\`Vault created at ${vaultPath}\`)` or similar.

- [ ] **Step 2: Add a generic nudge helper**

At the top of `src/commands/setup.ts`:

```ts
import { loadConfig } from '../config/config-manager';

async function maybeNudgeFirstService(): Promise<void> {
  const cfg = await loadConfig();
  const hasAny = Object.values(cfg.profiles).some((arr) => (arr ?? []).length > 0);
  if (hasAny) return;
  console.log('');
  console.log('Next: configure a service. Examples:');
  console.log('  agentio gmail profile add');
  console.log('  agentio whatsapp profile add');
  console.log('  agentio slack profile add');
  console.log('Run `agentio --help` to see all available services.');
}
```

- [ ] **Step 3: Call it from each setup success path**

After each existing success log line in `doInitialSetup`, `doMigrationSetup`, `doAdoptExisting`, add:

```ts
await maybeNudgeFirstService();
```

(Don't add to `doChangePassphrase` or `doMoveVault` — those are not first-run scenarios.)

- [ ] **Step 4: Verify by running setup against a fresh vault**

Manual smoke test (see Task 4 step 4 for the env-var pattern). Expected: after the "Vault created" line, the nudge prints.

- [ ] **Step 5: Commit**

```bash
git add src/commands/setup.ts
git commit -m "feat(setup): nudge user to configure a service after first-time setup"
```

---

## Task 14: Auto-start daemon when commands need it

**Files:**
- Create: `src/utils/daemon-ensure.ts` — shared helper
- Modify: `src/commands/whatsapp.ts`, `src/commands/schedule.ts` — use it before fallthroughs

- [ ] **Step 1: Write a failing test for the helper**

Create `src/utils/daemon-ensure.test.ts`:

```ts
import { describe, expect, test, mock } from 'bun:test';

// We can't easily mock fetch and child_process here — instead this test
// just exercises the decision logic. Inject the platform helpers.

import { decideDaemonAction } from './daemon-ensure';

describe('decideDaemonAction', () => {
  test('returns "running" when fetch /health succeeds', () => {
    expect(decideDaemonAction({ healthOk: true, installed: false })).toBe('running');
  });
  test('returns "start" when not running but installed', () => {
    expect(decideDaemonAction({ healthOk: false, installed: true })).toBe('start');
  });
  test('returns "install" when not installed at all', () => {
    expect(decideDaemonAction({ healthOk: false, installed: false })).toBe('install');
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun test src/utils/daemon-ensure.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/utils/daemon-ensure.ts`:

```ts
import { confirm } from '@inquirer/prompts';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawnSync } from 'bun';
import { isInteractive } from './interactive';
import { loadConfig } from '../config/config-manager';

export type DaemonAction = 'running' | 'start' | 'install';

/** Pure decision: given probe results, what should we do? */
export function decideDaemonAction(input: {
  healthOk: boolean;
  installed: boolean;
}): DaemonAction {
  if (input.healthOk) return 'running';
  if (input.installed) return 'start';
  return 'install';
}

function isDaemonInstalled(): boolean {
  if (process.platform === 'darwin') {
    return existsSync(join(homedir(), 'Library', 'LaunchAgents', 'me.agentio.daemon.plist'));
  }
  if (process.platform === 'linux') {
    return existsSync('/etc/systemd/system/agentio-daemon.service');
  }
  return false;
}

async function isDaemonHealthy(): Promise<boolean> {
  const cfg = await loadConfig();
  const port = cfg.daemon?.server?.port ?? 7890;
  const apiKey = cfg.daemon?.apiKey;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the daemon is running. If not, offer to start (and possibly install)
 * it. Returns true if the daemon is now reachable.
 */
export async function ensureDaemonRunning(opts: { autoYes?: boolean } = {}): Promise<boolean> {
  const healthOk = await isDaemonHealthy();
  if (healthOk) return true;
  const installed = isDaemonInstalled();
  const action = decideDaemonAction({ healthOk, installed });

  const confirmAction = async (msg: string): Promise<boolean> => {
    if (opts.autoYes) return true;
    if (!isInteractive()) return false;
    return confirm({ message: msg, default: true });
  };

  if (action === 'install') {
    const ok = await confirmAction('The agentio daemon is not installed. Install and start it now?');
    if (!ok) return false;
    spawnSync({ cmd: [process.execPath, ...process.argv.slice(1, 2), 'daemon', 'install'], stdout: 'inherit', stderr: 'inherit' });
    // After install on darwin/linux, the daemon is started by the installer.
    return await isDaemonHealthy();
  }
  if (action === 'start') {
    const ok = await confirmAction('The agentio daemon is installed but not running. Start it now?');
    if (!ok) return false;
    spawnSync({ cmd: [process.execPath, ...process.argv.slice(1, 2), 'daemon', 'start'], stdout: 'inherit', stderr: 'inherit' });
    // Give the daemon a moment to come up.
    await new Promise((r) => setTimeout(r, 1500));
    return await isDaemonHealthy();
  }
  return false;
}
```

- [ ] **Step 4: Run unit tests for the pure function**

```bash
bun test src/utils/daemon-ensure.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire into `whatsapp profile add`**

In `src/commands/whatsapp.ts`, find the `profile add` action's daemon-running check:

```ts
const daemonRunning = await isDaemonAvailable();
if (!daemonRunning) {
  console.log('\nDaemon is not running.');
  console.log('Start the daemon first, then run this command again:');
  console.log('  agentio daemon start');
  console.log(`  agentio whatsapp profile add --profile ${profileName}`);
  return;
}
```

Replace with:

```ts
const { ensureDaemonRunning } = await import('../utils/daemon-ensure');
const daemonRunning = await ensureDaemonRunning();
if (!daemonRunning) {
  console.log('\nCannot proceed without the daemon. Re-run after starting it:');
  console.log(`  agentio whatsapp profile add --profile ${profileName}`);
  return;
}
```

- [ ] **Step 6: Wire into `schedule watch`**

In `src/commands/schedule.ts`, the `watch` action ends with branch logic for "daemon installed but not running" / "not installed". Replace those branches with a call to `ensureDaemonRunning()` BEFORE attempting `/scheduler/reload`. If the user declines, fall through to the existing config-saved-but-no-reload state with the same hint messages.

- [ ] **Step 7: Verify**

Manual smoke (requires interactive terminal):
```bash
agentio daemon stop  # if running
bun run dev whatsapp profile add --profile test
# Expected: prompted "Start daemon now?"; declining proceeds with re-run hint
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cli): offer to auto-start the daemon when commands need it"
```

---

## Task 15: `agentio doctor` — unified health check

**Files:**
- Create: `src/commands/doctor.ts`, `src/commands/doctor.test.ts`
- Modify: `src/index.ts` (register the command)

- [ ] **Step 1: Write failing test for the pure check-collector**

Create `src/commands/doctor.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { renderChecks, type Check } from './doctor';

describe('renderChecks', () => {
  test('formats ok/warn/error with leading symbols', () => {
    const checks: Check[] = [
      { name: 'Vault', status: 'ok', detail: 'configured at ~/.config/agentio/vault.enc' },
      { name: 'Daemon', status: 'warn', detail: 'installed but not running' },
      { name: 'Profiles', status: 'error', detail: 'no profiles configured', fix: 'agentio gmail profile add' },
    ];
    const out = renderChecks(checks);
    expect(out).toContain('✓ Vault');
    expect(out).toContain('!  Daemon');
    expect(out).toContain('✗ Profiles');
    expect(out).toContain('agentio gmail profile add');
  });
});
```

- [ ] **Step 2: Run test**

```bash
bun test src/commands/doctor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `doctor.ts`**

Create `src/commands/doctor.ts`:

```ts
import { Command } from 'commander';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { handleError } from '../utils/errors';
import { vaultExists } from '../vault/vault';
import { loadConfig } from '../config/config-manager';
import { pointerPath, readPointer } from '../vault/pointer';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail?: string;
  fix?: string;
}

const SYMBOL: Record<Check['status'], string> = {
  ok: '✓',
  warn: '!',
  error: '✗',
};

export function renderChecks(checks: Check[]): string {
  const lines: string[] = [];
  for (const c of checks) {
    const symbol = SYMBOL[c.status];
    const head = `${symbol} ${c.name}`.padEnd(20);
    const detail = c.detail ? `— ${c.detail}` : '';
    lines.push(`${head} ${detail}`.trimEnd());
    if (c.fix) lines.push(`    fix: ${c.fix}`);
  }
  return lines.join('\n');
}

async function checkVault(): Promise<Check> {
  if (!(await vaultExists())) {
    return {
      name: 'Vault',
      status: 'error',
      detail: 'not configured',
      fix: 'agentio setup',
    };
  }
  const path = await readPointer();
  return { name: 'Vault', status: 'ok', detail: `at ${path}` };
}

async function checkDaemon(): Promise<Check> {
  const cfg = await loadConfig().catch(() => null);
  const port = cfg?.daemon?.server?.port ?? 7890;
  const apiKey = cfg?.daemon?.apiKey;

  let healthy = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
      signal: AbortSignal.timeout(1000),
    });
    healthy = res.ok;
  } catch { /* not running */ }

  if (healthy) return { name: 'Daemon', status: 'ok', detail: 'running' };

  const installedDarwin = existsSync(join(homedir(), 'Library', 'LaunchAgents', 'me.agentio.daemon.plist'));
  const installedLinux = existsSync('/etc/systemd/system/agentio-daemon.service');
  if (installedDarwin || installedLinux) {
    return { name: 'Daemon', status: 'warn', detail: 'installed but not running', fix: 'agentio daemon start' };
  }
  return { name: 'Daemon', status: 'warn', detail: 'not installed', fix: 'agentio daemon install' };
}

async function checkProfiles(): Promise<Check> {
  const cfg = await loadConfig().catch(() => null);
  if (!cfg) return { name: 'Profiles', status: 'error', detail: 'cannot read config' };
  const total = Object.values(cfg.profiles).reduce((acc, arr) => acc + (arr ?? []).length, 0);
  if (total === 0) {
    return {
      name: 'Profiles',
      status: 'warn',
      detail: 'no services configured',
      fix: 'agentio <service> profile add (e.g. gmail, slack, whatsapp)',
    };
  }
  return { name: 'Profiles', status: 'ok', detail: `${total} configured` };
}

async function checkLegacyPlists(): Promise<Check | null> {
  if (process.platform !== 'darwin') return null;
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  if (!existsSync(dir)) return null;
  const legacy = (await import('fs')).readdirSync(dir)
    .filter((f) => f.startsWith('me.agentio.schedule.') && f.endsWith('.plist'));
  if (legacy.length === 0) return null;
  return {
    name: 'Legacy plists',
    status: 'warn',
    detail: `${legacy.length} per-schedule plist(s) detected`,
    fix: 'agentio schedule migrate',
  };
}

async function checkWatchedFolders(): Promise<Check | null> {
  const cfg = await loadConfig().catch(() => null);
  const folders = cfg?.daemon?.scheduler?.watchedFolders ?? [];
  if (folders.length === 0) return null;
  const missing = folders.filter((f) => !existsSync(f.path));
  if (missing.length > 0) {
    return {
      name: 'Watched folders',
      status: 'warn',
      detail: `${missing.length} folder(s) missing on disk: ${missing.map((m) => m.path).join(', ')}`,
      fix: `agentio schedule unwatch <folder>`,
    };
  }
  return { name: 'Watched folders', status: 'ok', detail: `${folders.length} folder(s)` };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Diagnose vault, daemon, profiles, and watched folders')
    .action(async () => {
      try {
        const checks: Check[] = [];
        checks.push(await checkVault());
        checks.push(await checkDaemon());
        checks.push(await checkProfiles());
        const w = await checkWatchedFolders();
        if (w) checks.push(w);
        const legacy = await checkLegacyPlists();
        if (legacy) checks.push(legacy);

        console.log(renderChecks(checks));

        const errors = checks.filter((c) => c.status === 'error');
        if (errors.length > 0) process.exit(1);
      } catch (e) {
        handleError(e);
      }
    });
}
```

- [ ] **Step 4: Run unit test**

```bash
bun test src/commands/doctor.test.ts
```

Expected: PASS.

- [ ] **Step 5: Register in `src/index.ts`**

Add:
```ts
import { registerDoctorCommand } from './commands/doctor';
// ...
registerDoctorCommand(program);
```

- [ ] **Step 6: Smoke test**

```bash
bun run dev doctor
```

Expected: prints checks for vault / daemon / profiles, plus warnings for any legacy plists or missing watched folders.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(cli): \`agentio doctor\` for unified health diagnosis"
```

---

## Task 16: Unified `agentio profile` namespace

**Files:**
- Create: `src/commands/profile.ts`, `src/commands/profile.test.ts`
- Modify: `src/index.ts`
- Modify: `src/commands/reauth.ts` — extract its action into a callable function

This task is bigger than the others. The plan below breaks it into substeps within one task, each with its own commit. The implementer can ship each substep separately if desired.

### Substep 16a — `agentio profile list [service]`

- [ ] Write `src/commands/profile.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { formatProfileList, type ProfileSummary } from './profile';

describe('formatProfileList', () => {
  test('groups profiles by service when no service filter', () => {
    const summaries: ProfileSummary[] = [
      { service: 'gmail', name: 'work' },
      { service: 'gmail', name: 'personal' },
      { service: 'slack', name: 'main' },
    ];
    const out = formatProfileList(summaries);
    expect(out).toContain('gmail:');
    expect(out).toContain('  work');
    expect(out).toContain('  personal');
    expect(out).toContain('slack:');
    expect(out).toContain('  main');
  });

  test('renders empty-state hint when no profiles', () => {
    const out = formatProfileList([]);
    expect(out).toContain('No profiles configured');
    expect(out).toContain('agentio profile add');
  });
});
```

- [ ] Run test (expect fail).
- [ ] Implement `src/commands/profile.ts`:

```ts
import { Command } from 'commander';
import type { ServiceName } from '../types/config';
import { listProfiles } from '../config/config-manager';
import { handleError } from '../utils/errors';

export interface ProfileSummary {
  service: ServiceName;
  name: string;
  readOnly?: boolean;
}

export function formatProfileList(summaries: ProfileSummary[]): string {
  if (summaries.length === 0) {
    return 'No profiles configured.\nAdd one with: agentio profile add <service>';
  }
  const byService = new Map<ServiceName, ProfileSummary[]>();
  for (const s of summaries) {
    const arr = byService.get(s.service) ?? [];
    arr.push(s);
    byService.set(s.service, arr);
  }
  const lines: string[] = [];
  for (const [svc, profiles] of byService) {
    lines.push(`${svc}:`);
    for (const p of profiles) {
      const ro = p.readOnly ? ' [read-only]' : '';
      lines.push(`  ${p.name}${ro}`);
    }
  }
  return lines.join('\n');
}

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command('profile')
    .description('Manage profiles across services');

  profile
    .command('list')
    .argument('[service]', 'Limit to one service')
    .description('List configured profiles')
    .action(async (service?: ServiceName) => {
      try {
        const result = await listProfiles(service);
        const summaries: ProfileSummary[] = [];
        for (const r of result) {
          for (const p of r.profiles) {
            summaries.push({ service: r.service, name: p.name, readOnly: p.readOnly });
          }
        }
        console.log(formatProfileList(summaries));
      } catch (e) {
        handleError(e);
      }
    });

  // 16b: profile add — registered in next substep
  // 16c: profile remove
  // 16d: profile reauth
}
```

- [ ] Register in `src/index.ts`:
```ts
import { registerProfileCommands } from './commands/profile';
// ...
registerProfileCommands(program);
```
- [ ] Verify: `bun run dev profile list` shows all profiles grouped by service.
- [ ] Commit: `feat(profile): add unified \`profile list\` command`

### Substep 16b — `agentio profile add <service> [name]`

- [ ] Decide: instead of duplicating the OAuth/credentials flow per service, the unified `profile add` delegates to the existing per-service implementation. Each service's `register*Commands` function exposes its profile-add action via a named export — refactor as you go.

For each service file (`gmail.ts`, `slack.ts`, etc.), extract the body of its `profile add` action into a named exported function:

```ts
// in src/commands/gmail.ts
export async function gmailProfileAdd(opts: { profile?: string; readOnly?: boolean }): Promise<void> {
  // ... existing action body ...
}

// then the per-service command becomes:
profile.command('add').action(gmailProfileAdd);
```

- [ ] In `src/commands/profile.ts`, add:

```ts
import { gmailProfileAdd } from './gmail';
import { slackProfileAdd } from './slack';
// ... etc for every service that supports profiles ...

const ADD_HANDLERS: Partial<Record<ServiceName, (opts: { profile?: string; readOnly?: boolean }) => Promise<void>>> = {
  gmail: gmailProfileAdd,
  slack: slackProfileAdd,
  // ...
};

profile
  .command('add')
  .argument('<service>', 'Service name (gmail, slack, telegram, ...)')
  .option('--profile <name>', 'Profile name')
  .option('--read-only', 'Create as read-only profile')
  .action(async (service: string, opts: { profile?: string; readOnly?: boolean }) => {
    try {
      const handler = ADD_HANDLERS[service as ServiceName];
      if (!handler) {
        throw new CliError('INVALID_PARAMS',
          `Unknown service: ${service}`,
          `Known services: ${Object.keys(ADD_HANDLERS).join(', ')}`);
      }
      await handler(opts);
    } catch (e) { handleError(e); }
  });
```

- [ ] Verify: `bun run dev profile add gmail` runs the same flow as `bun run dev gmail profile add`.
- [ ] Commit: `feat(profile): add unified \`profile add <service>\` command`

### Substep 16c — `agentio profile remove <service> <name>`

- [ ] Same pattern as 16b: extract per-service `profileRemove` actions, build a handler map, register the unified command.
- [ ] Verify and commit: `feat(profile): add unified \`profile remove <service> <name>\` command`

### Substep 16d — `agentio profile reauth <service> [name]`

- [ ] Read `src/commands/reauth.ts`. Identify the action body. Extract into an exported `reauthProfile(service, name?)` function.
- [ ] Add the unified command:
```ts
profile
  .command('reauth')
  .argument('<service>', 'Service name')
  .argument('[name]', 'Profile name (auto-resolves if exactly one)')
  .description('Re-authenticate an expired or invalid profile')
  .action(async (service: string, name: string | undefined) => {
    try {
      await reauthProfile(service as ServiceName, name);
    } catch (e) { handleError(e); }
  });
```
- [ ] Verify and commit: `feat(profile): add unified \`profile reauth\` command (folds in top-level \`reauth\`)`

### Substep 16e — Mark per-service `profile *` subcommands as aliases

- [ ] For each service's `profile add|list|remove` subcommand, no behavior change is needed (they already delegate to the same exported handler functions after 16b/16c). Optional: append `(alias of \`agentio profile add ${service}\`)` to the description.
- [ ] Optionally bump the help-formatter groups in `src/index.ts` to include `profile` under "Setup" or "Advanced".
- [ ] Commit: `chore(profile): cross-link per-service profile commands as aliases`

---

## Spec Coverage Self-Review

**Suggestion → Task(s):**

| Suggestion | Tasks |
|---|---|
| #11 multi-profile error includes names | Task 1 |
| #8 hide `gateway` from main help | Task 2 |
| #9 service description consistency | Task 3 |
| #5 empty-state guidance audit | Task 4 |
| #4 schedule cleanup (`runs`→`history`, `sync`→`check`, `watched`→`list --folders`, hide `migrate`) | Tasks 5-8 |
| #10 symmetric `add`/`remove` arg shapes | Task 9 |
| #1 grouped top-level help | Task 10 |
| (companion to #1) hide low-frequency commands | Task 11 |
| #6 friendlier vault errors + first-run nudge | Tasks 12, 13 |
| #7 auto-install/auto-start daemon | Task 14 |
| #3 `agentio doctor` | Task 15 |
| #2 unified `profile` namespace | Task 16 (substeps a-e) |

All 11 suggestions covered.

**Dependencies between tasks:**
- Task 10 (grouped help) references `doctor` and `profile` in its group lists; those commands are added later (Tasks 15, 16). The grouper ignores names that don't exist, so order is safe — but help output is most useful only after Tasks 15 and 16 land.
- Task 14 (auto-start) depends on Task 12 only loosely (both touch user-facing error messaging).
- Task 16 (unified profile) is the most invasive. Recommend shipping it last.

**Type / API consistency check:**
- `Check` interface (Task 15) is internal to `doctor.ts` — no cross-task references.
- `ProfileSummary` interface (Task 16) is internal to `profile.ts`.
- `multipleProfilesError` helper (Task 1) lives in `src/utils/errors.ts` — used in many service commands; signature `(service, names) => CliError` is stable across callsites.
- `ensureDaemonRunning` (Task 14) returns `Promise<boolean>` — used at two call sites with consistent semantics.
- `applyGroupedHelp` (Task 10) takes `(program, CommandGroups)` — single caller in `src/index.ts`.

**Test commands at end of each phase:**
- After every task: `bun run typecheck && bun test`
- After Task 4: smoke test on a fresh `HOME` (see step 4)
- After Task 14: interactive smoke test for the auto-start prompt
- After Task 15: `bun run dev doctor` on a partial install to verify warn states render
