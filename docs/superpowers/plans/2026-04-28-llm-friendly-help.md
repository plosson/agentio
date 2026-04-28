# LLM-Friendly `--help` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-friendly example invocations to every `agentio` command's `--help`, with examples as the single source of truth that also feeds an auto-generated `agentio skill <service>` SKILL.md output.

**Architecture:** Per-leaf-command examples are registered via a thin `addExamples(cmd, text)` helper that (a) calls Commander's `cmd.addHelpText('after', ...)` so the text appears in `--help`, and (b) records the raw text in a `WeakMap<Command, string>` side-table so the new `agentio skill` command can extract it without re-parsing help output. A CI test walks the Commander tree and asserts every non-exempt leaf command has a registered examples block.

**Tech Stack:** TypeScript, Bun, Commander.js, bun:test.

**Spec:** `docs/superpowers/specs/2026-04-28-llm-friendly-help-design.md`

---

## File Structure

**New files:**
- `src/utils/command-tree.ts` — extracted `collectCommands()` from `docs.ts`, plus the `addExamples()` helper and the side-table that stores per-command example text.
- `src/commands/skill.ts` — registers the hidden `agentio skill` command.
- `src/commands/help-examples.test.ts` — CI gate that fails if any non-exempt leaf command lacks examples.
- `src/commands/skill.test.ts` — unit tests for the SKILL.md generator.

**Modified files:**
- `src/commands/docs.ts` — replace local `collectCommands()` with the import from `command-tree.ts`.
- `src/index.ts` — register `registerSkillCommand(program)`.
- Per-service command files (one task each):
  `gmail.ts`, `gdocs.ts`, `gdrive.ts`, `telegram.ts`, `gchat.ts`, `gcal.ts`, `gsheets.ts`, `gtasks.ts`, `github.ts`, `jira.ts`, `slack.ts`, `rss.ts`, `discourse.ts`, `sql.ts`, `whatsapp.ts`, `daemon.ts`, `schedule.ts`, `mcp.ts`, `server.ts`, `teleport.ts`, `reauth.ts`, `setup.ts`, `doctor.ts`, `profile.ts`, `update.ts`, `status.ts`, `config.ts`.

**Regenerated files:**
- `claude/skills/agentio-<service>/SKILL.md` — six existing files overwritten; new files written for every other service that has user-facing commands.

---

## Task 1: Extract `collectCommands` and add `addExamples` helper

**Files:**
- Create: `src/utils/command-tree.ts`
- Modify: `src/commands/docs.ts`
- Test: `src/utils/command-tree.test.ts`

- [ ] **Step 1: Create the failing test**

Write `src/utils/command-tree.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test src/utils/command-tree.test.ts`
Expected: FAIL — `Cannot find module './command-tree'`.

- [ ] **Step 3: Implement `command-tree.ts`**

Write `src/utils/command-tree.ts`:

```typescript
import { Command } from 'commander';

export interface CommandInfo {
  fullPath: string;
  description: string;
  arguments: string[];
  options: Array<{ flags: string; description: string; defaultValue?: string }>;
  examples?: string;
}

const EXAMPLES = new WeakMap<Command, string>();

export function addExamples(cmd: Command, text: string): Command {
  EXAMPLES.set(cmd, text);
  cmd.addHelpText('after', '\n' + text);
  return cmd;
}

export function getExamples(cmd: Command): string | undefined {
  return EXAMPLES.get(cmd);
}

export function collectCommands(cmd: Command, parentPath: string = ''): CommandInfo[] {
  const results: CommandInfo[] = [];
  const help = cmd.createHelp();
  const subcommands = help.visibleCommands(cmd).filter((c) => c.name() !== 'help');

  for (const subcmd of subcommands) {
    const fullPath = parentPath ? `${parentPath} ${subcmd.name()}` : subcmd.name();

    const args = help.visibleArguments(subcmd).map((arg) => {
      const argName = arg.variadic ? `${arg.name()}...` : arg.name();
      return arg.required ? `<${argName}>` : `[${argName}]`;
    });

    const options = help
      .visibleOptions(subcmd)
      .filter((opt) => !opt.long?.includes('help'))
      .map((opt) => ({
        flags: opt.flags,
        description: opt.description,
        defaultValue: opt.defaultValue,
      }));

    const description = subcmd.description() || '';

    const childCommands = help.visibleCommands(subcmd).filter((c) => c.name() !== 'help');
    if (childCommands.length === 0 || options.length > 0 || args.length > 0) {
      results.push({
        fullPath,
        description,
        arguments: args,
        options,
        examples: getExamples(subcmd),
      });
    }

    results.push(...collectCommands(subcmd, fullPath));
  }

  return results;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test src/utils/command-tree.test.ts`
Expected: PASS — all four tests green.

- [ ] **Step 5: Replace local `collectCommands` in `docs.ts`**

In `src/commands/docs.ts`, delete the local `CommandInfo` interface and the local `collectCommands` function. Replace with an import:

```typescript
import { collectCommands, type CommandInfo } from '../utils/command-tree';
```

Leave the rest of `docs.ts` (the `formatOption`, `EXCLUDED_COMMANDS`, `generateDocs`, `registerDocsCommand` functions) unchanged.

- [ ] **Step 6: Verify `docs` still works**

Run: `bun run dev docs --service gmail | head -20`
Expected: prints `# agentio CLI v...` followed by gmail commands. No errors.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/utils/command-tree.ts src/utils/command-tree.test.ts src/commands/docs.ts
git commit -m "refactor(commands): extract command-tree util with addExamples helper"
```

---

## Task 2: Build `agentio skill` command

**Files:**
- Create: `src/commands/skill.ts`
- Create: `src/commands/skill.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing test**

Write `src/commands/skill.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { addExamples } from '../utils/command-tree';
import { generateSkill } from './skill';

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
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `bun test src/commands/skill.test.ts`
Expected: FAIL — `Cannot find module './skill'`.

- [ ] **Step 3: Implement `skill.ts`**

Write `src/commands/skill.ts`:

```typescript
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { collectCommands, type CommandInfo } from '../utils/command-tree';
import { CliError, handleError } from '../utils/errors';

const SERVICE_DESCRIPTIONS: Record<string, string> = {
  gmail: 'Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export.',
  gdocs: 'Use when interacting with Google Docs via the agentio CLI - list, read, create.',
  gdrive: 'Use when interacting with Google Drive via the agentio CLI - list, search, download, upload, folder navigation.',
  telegram: 'Use when interacting with Telegram via the agentio CLI - send messages, manage inbox/outbox via the daemon.',
  gchat: 'Use when interacting with Google Chat via the agentio CLI - send messages, list spaces, read history.',
  gcal: 'Use when interacting with Google Calendar via the agentio CLI.',
  gsheets: 'Use when interacting with Google Sheets via the agentio CLI.',
  gtasks: 'Use when interacting with Google Tasks via the agentio CLI.',
  github: 'Use when interacting with GitHub via the agentio CLI.',
  jira: 'Use when interacting with JIRA via the agentio CLI - search issues, comment, transition.',
  slack: 'Use when sending Slack messages via the agentio CLI.',
  rss: 'Use when reading RSS feeds via the agentio CLI.',
  discourse: 'Use when interacting with Discourse forums via the agentio CLI.',
  sql: 'Use when running SQL queries via the agentio CLI.',
  whatsapp: 'Use when interacting with WhatsApp via the agentio CLI - send/receive, group management. Requires daemon.',
  daemon: 'Use to manage the agentio daemon (real-time messaging connections + scheduler).',
  schedule: 'Use to manage agentio scheduled .run.md prompts in watched folders.',
};

function formatOption(opt: { flags: string; description: string; defaultValue?: string }): string {
  let line = `- \`${opt.flags}\``;
  if (opt.description) {
    line += `: ${opt.description}`;
  }
  if (opt.defaultValue !== undefined && opt.defaultValue !== '') {
    line += ` (default: ${opt.defaultValue})`;
  }
  return line;
}

function renderCommand(cmd: CommandInfo): string {
  const lines: string[] = [];
  let header = `## ${cmd.fullPath}`;
  if (cmd.arguments.length > 0) {
    header += ` ${cmd.arguments.join(' ')}`;
  }
  lines.push(header);
  lines.push('');

  if (cmd.description) {
    lines.push(cmd.description);
    lines.push('');
  }

  if (cmd.options.length > 0) {
    lines.push('Options:');
    lines.push('');
    for (const opt of cmd.options) {
      lines.push(formatOption(opt));
    }
    lines.push('');
  }

  if (cmd.examples) {
    lines.push('```');
    lines.push(cmd.examples.trim());
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

export function generateSkill(program: Command, service: string): string {
  const description = SERVICE_DESCRIPTIONS[service]
    ?? `Use when interacting with ${service} via the agentio CLI.`;

  const all = collectCommands(program, 'agentio');
  const scoped = all.filter((cmd) => {
    if (cmd.fullPath.includes(' profile ')) return false;
    const parts = cmd.fullPath.split(' ');
    return parts[1] === service;
  });

  if (scoped.length === 0) {
    throw new CliError('NOT_FOUND', `no commands found for service "${service}"`);
  }

  const out: string[] = [];
  out.push('---');
  out.push(`name: agentio-${service}`);
  out.push(`description: ${description}`);
  out.push('---');
  out.push('');
  out.push(`# ${service.charAt(0).toUpperCase() + service.slice(1)} via agentio`);
  out.push('');
  out.push(`Auto-generated from \`agentio skill ${service}\`. Do not edit by hand.`);
  out.push('');

  for (const cmd of scoped) {
    out.push(renderCommand(cmd));
  }

  return out.join('\n').trimEnd() + '\n';
}

function listServices(program: Command): string[] {
  const all = collectCommands(program, 'agentio');
  const services = new Set<string>();
  for (const cmd of all) {
    if (cmd.fullPath.includes(' profile ')) continue;
    const parts = cmd.fullPath.split(' ');
    if (parts[1]) services.add(parts[1]);
  }
  return Array.from(services).sort();
}

function skillFilePath(service: string): string {
  return path.join('claude', 'skills', `agentio-${service}`, 'SKILL.md');
}

export function registerSkillCommand(program: Command): void {
  const cmd = program
    .command('skill', { hidden: true })
    .description('Emit auto-generated SKILL.md content for an agentio service')
    .argument('[service]', 'Service name (e.g. gmail). Omit with --all or --list.')
    .option('--all', 'Write SKILL.md for every service in claude/skills/')
    .option('--list', 'List services with registered commands')
    .action((service, options) => {
      try {
        if (options.list) {
          for (const s of listServices(program)) {
            console.log(s);
          }
          return;
        }

        if (options.all) {
          for (const s of listServices(program)) {
            const content = generateSkill(program, s);
            const file = skillFilePath(s);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, content);
            console.error(`wrote ${file}`);
          }
          return;
        }

        if (!service) {
          throw new CliError('INVALID_PARAMS', 'specify a service, --all, or --list');
        }

        console.log(generateSkill(program, service));
      } catch (error) {
        handleError(error);
      }
    });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test src/commands/skill.test.ts`
Expected: PASS — all five tests green.

- [ ] **Step 5: Register the command in `index.ts`**

Open `src/index.ts`. Find the line `import { registerDocsCommand } from './commands/docs';` and add immediately below:

```typescript
import { registerSkillCommand } from './commands/skill';
```

Find `registerDocsCommand(program);` and add immediately below:

```typescript
registerSkillCommand(program);
```

- [ ] **Step 6: Smoke test the command**

Run: `bun run dev skill --list`
Expected: prints a sorted list of service names (gmail, telegram, etc.).

Run: `bun run dev skill nonexistent`
Expected: exits non-zero with `no commands found for service "nonexistent"`.

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/commands/skill.ts src/commands/skill.test.ts src/index.ts
git commit -m "feat(skill): add hidden 'agentio skill' command for SKILL.md generation"
```

---

## Task 3: Add the `help-examples` CI gate (with pending allowlist)

**Files:**
- Create: `src/commands/help-examples.test.ts`

This test is the gate that drives every subsequent task. It walks the whole Commander tree and fails if any non-exempt leaf command lacks examples. We start it in **opt-in mode**: a single `EXEMPT_PENDING` set lists every leaf command that does not yet have examples. Each per-service task removes entries from this set as it adds examples. When the set is empty, the test is fully strict.

- [ ] **Step 1: Enumerate every current leaf command**

Run: `bun run dev docs | grep '^## ' | sed 's/^## //'`

Copy the output. This is the list of every leaf command, formatted as `agentio <service> <subcommand>`. Strip the leading `agentio ` from each line.

- [ ] **Step 2: Write the test with the full enumeration as `EXEMPT_PENDING`**

Write `src/commands/help-examples.test.ts`:

Note: this test imports `createProgram` from `../index-program`, which we create in Step 3. The import will fail until Step 3 lands — that is expected; the test cannot run until the module exists.

```typescript
import { describe, expect, it } from 'bun:test';
import { collectCommands } from '../utils/command-tree';
import { createProgram } from '../index-program';

// Leaf commands NOT YET migrated to addExamples. Drive this list to empty.
// Format: 'service subcommand' (no leading 'agentio ').
const EXEMPT_PENDING = new Set<string>([
  // ⬇️ Paste the output of `bun run dev docs | grep '^## '` here, one per line,
  //    stripped of the leading 'agentio '. Each entry must match `cmd.fullPath`
  //    minus the leading 'agentio '.
  // Example:
  // 'gmail list',
  // 'gmail get',
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
```

- [ ] **Step 3: Extract a `createProgram()` factory**

`src/index.ts` currently runs `program.parseAsync(process.argv)` at module load. We need a factory we can call from tests without parsing argv.

Open `src/index.ts`. Wrap the entire program-construction block (everything from `const program = new Command();` through the last `register*Command(program)` call, but NOT the `parseAsync` call) into an exported function in a new module. Concretely:

Create `src/index-program.ts` with the factory:

```typescript
import { Command } from 'commander';
import { registerSetupCommand } from './commands/setup';
// ⬇️ copy ALL register* imports from src/index.ts here
// (gmail, gdocs, gdrive, telegram, gchat, gcal, gsheets, gtasks, github, jira,
// slack, rss, discourse, sql, whatsapp, daemon, schedule, mcp, server,
// teleport, reauth, doctor, profile, update, status, config, claude, docs, skill)

export function createProgram(): Command {
  const program = new Command();
  // ⬇️ copy the program.name(...).description(...).version(...) chain from index.ts
  // ⬇️ copy every register*Command(program) call here in the same order
  return program;
}
```

Then in `src/index.ts`, replace the inline construction with:

```typescript
import { createProgram } from './index-program';

const program = createProgram();
program.parseAsync(process.argv);
```

- [ ] **Step 4: Run the test and confirm it passes (all commands in EXEMPT_PENDING)**

Run: `bun test src/commands/help-examples.test.ts`
Expected: PASS — both tests green. (Every leaf command is in EXEMPT_PENDING, so no offenders.)

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/commands/help-examples.test.ts src/index-program.ts src/index.ts
git commit -m "test: add help-examples gate with full pending allowlist"
```

---

## Task 4: Add examples to `gmail` (reference implementation)

This is the worked-out reference. Every subsequent service task follows the same pattern.

**Files:**
- Modify: `src/commands/gmail.ts`
- Modify: `src/commands/help-examples.test.ts` (remove gmail entries from `EXEMPT_PENDING`)
- Regenerate: `claude/skills/agentio-gmail/SKILL.md`

- [ ] **Step 1: List the leaf commands in `gmail.ts`**

Run: `bun run dev docs --service gmail | grep '^## '`
Expected output (verify against your tree):
```
## agentio gmail list
## agentio gmail get
## agentio gmail search
## agentio gmail send
## agentio gmail draft
## agentio gmail archive
## agentio gmail mark
## agentio gmail attachment
## agentio gmail export
```

Note: `gmail search` already has an `addHelpText('after', ...)` block — convert it to use `addExamples` so it ends up in the side-table.

- [ ] **Step 2: Add the import**

At the top of `src/commands/gmail.ts`, add:

```typescript
import { addExamples } from '../utils/command-tree';
```

- [ ] **Step 3: Add `addExamples(...)` for each leaf command**

For each of the nine leaf commands above, add a call to `addExamples(cmd, ...)` immediately after the `.action(...)` block. Examples must follow the spec format: heading `Examples:`, blank line, then 2–4 entries each consisting of a `# intent` comment line and one (or one continued) command line.

Reference content for `gmail list`:

```typescript
addExamples(
  gmail.command('list')
    /* ...existing chain unchanged... */
    .action(/* ...existing... */),
  `Examples:

  # 10 most recent messages in inbox
  agentio gmail list

  # last 50 unread messages
  agentio gmail list --limit 50 --query "is:unread"

  # filter by label
  agentio gmail list --label inbox --label important`,
);
```

If wrapping the existing `.command(...).description(...).option(...).action(...)` chain in `addExamples(...)` makes the file hard to read, an equivalent pattern is to assign the chain to a variable first:

```typescript
const listCmd = gmail
  .command('list')
  .description('List messages')
  .option('--limit <n>', 'Max results', '10')
  .option('--query <query>', 'Search query')
  .option('--label <label>', 'Filter by label', collect, [])
  .option('--profile <name>', 'Profile name (optional if only one profile exists)')
  .action(/* ...unchanged... */);

addExamples(listCmd, `Examples:

  # 10 most recent
  agentio gmail list

  # ...etc`);
```

Use whichever style keeps each command's chain readable. Both are equivalent.

For the remaining eight commands, write 2–4 examples per command. Read each command's existing `.option(...)` calls to understand the flags, and consult `claude/skills/agentio-gmail/SKILL.md` for inspiration. Realistic placeholder values (`alice@example.com`, `18c4f1a2b3d`) — never `<email>` or `<id>`.

For `gmail search`: replace the existing `.addHelpText('after', '...')` call with `addExamples(searchCmd, '...')` containing the same content (already prefixed `Query Syntax Examples:` — change the heading to `Examples:` and shape the body into 3–4 representative `agentio gmail search --query "..."` invocations).

- [ ] **Step 4: Verify `--help` shows the examples**

Run: `bun run dev gmail list --help`
Expected: standard help, then a blank line, then `Examples:`, then the example block.

Run: `bun run dev gmail send --help` and check the same.

- [ ] **Step 5: Remove gmail entries from `EXEMPT_PENDING`**

In `src/commands/help-examples.test.ts`, delete the nine `'gmail ...'` entries from `EXEMPT_PENDING`.

- [ ] **Step 6: Run the gate test**

Run: `bun test src/commands/help-examples.test.ts`
Expected: PASS — gmail commands are no longer pending and they all have examples.

If any gmail command is reported as missing, that command was not migrated in step 3. Add `addExamples(...)` for it.

- [ ] **Step 7: Regenerate the gmail SKILL.md**

Run: `bun run dev skill gmail > claude/skills/agentio-gmail/SKILL.md`

- [ ] **Step 8: Inspect the regenerated file**

Run: `head -40 claude/skills/agentio-gmail/SKILL.md`
Expected: frontmatter, then `# Gmail via agentio`, then `## agentio gmail list`, options, and the examples block in a fenced code block.

- [ ] **Step 9: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 10: Run typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add src/commands/gmail.ts src/commands/help-examples.test.ts claude/skills/agentio-gmail/SKILL.md
git commit -m "feat(gmail): add LLM-friendly examples to all gmail commands"
```

---

## Tasks 5–N: Add examples to remaining services

Each service gets its own task, identical in structure to Task 4. List of services and their command files (each task uses Task 4's pattern verbatim, substituting the service name and command file):

| Task | Service     | Command file                  | Has existing SKILL.md? |
|------|-------------|-------------------------------|------------------------|
| 5    | telegram    | `src/commands/telegram.ts`    | yes — overwrite        |
| 6    | gchat       | `src/commands/gchat.ts`       | yes — overwrite        |
| 7    | jira        | `src/commands/jira.ts`        | yes — overwrite        |
| 8    | rss         | `src/commands/rss.ts`         | yes — overwrite        |
| 9    | schedule    | `src/commands/schedule.ts`    | yes — overwrite        |
| 10   | gdocs       | `src/commands/gdocs.ts`       | no — create folder     |
| 11   | gdrive      | `src/commands/gdrive.ts`      | no — create folder     |
| 12   | gcal        | `src/commands/gcal.ts`        | no — create folder     |
| 13   | gsheets     | `src/commands/gsheets.ts`     | no — create folder     |
| 14   | gtasks      | `src/commands/gtasks.ts`      | no — create folder     |
| 15   | github      | `src/commands/github.ts`      | no — create folder     |
| 16   | slack       | `src/commands/slack.ts`       | no — create folder     |
| 17   | discourse   | `src/commands/discourse.ts`   | no — create folder     |
| 18   | sql         | `src/commands/sql.ts`         | no — create folder     |
| 19   | whatsapp    | `src/commands/whatsapp.ts`    | no — create folder     |
| 20   | daemon      | `src/commands/daemon.ts`      | no — create folder     |
| 21   | mcp         | `src/commands/mcp.ts`         | no — create folder     |
| 22   | server      | `src/commands/server.ts`      | no — create folder     |
| 23   | teleport    | `src/commands/teleport.ts`    | no — create folder     |
| 24   | reauth      | `src/commands/reauth.ts`      | no — create folder     |
| 25   | doctor      | `src/commands/doctor.ts`      | no — create folder     |
| 26   | setup       | `src/commands/setup.ts`       | no — create folder     |
| 27   | profile     | `src/commands/profile.ts`     | no — create folder     |
| 28   | update      | `src/commands/update.ts`      | no — create folder     |
| 29   | status      | `src/commands/status.ts`      | no — create folder     |
| 30   | config      | `src/commands/config.ts`      | no — create folder     |

For each task above, perform the same eleven steps as Task 4 with the service name substituted. Two specifics:

**For services that don't have an existing SKILL.md folder**: the `agentio skill <service> > claude/skills/agentio-<service>/SKILL.md` redirection (Step 7 of Task 4) will fail because the folder does not exist. Instead, run:

```bash
mkdir -p claude/skills/agentio-<service>
bun run dev skill <service> > claude/skills/agentio-<service>/SKILL.md
```

Or simply run `bun run dev skill --all` after the per-service work is done to write all files at once. (You can run that as a final verification step in Task 31.)

**For `daemon` and `schedule`**: these have multi-level subcommands (e.g. `agentio daemon profile add` is excluded by the `profile` filter, but `agentio schedule history <id>` is a real leaf). The `EXEMPT_PENDING` enumeration from Task 3 already captured these correctly — just remove them from the set as you migrate.

The commit message for each per-service task is:

```bash
git commit -m "feat(<service>): add LLM-friendly examples to all <service> commands"
```

---

## Task 31: Final verification

**Files:**
- Modify: `src/commands/help-examples.test.ts` (confirm `EXEMPT_PENDING` is empty)

- [ ] **Step 1: Confirm `EXEMPT_PENDING` is empty**

Open `src/commands/help-examples.test.ts`. The `EXEMPT_PENDING` set should now be:

```typescript
const EXEMPT_PENDING = new Set<string>([]);
```

If it is not empty, return to whichever per-service task left entries behind.

- [ ] **Step 2: Run the gate test**

Run: `bun test src/commands/help-examples.test.ts`
Expected: PASS — both tests green with an empty allowlist.

- [ ] **Step 3: Run `agentio skill --all` and confirm no diff**

Run: `bun run dev skill --all && git status claude/skills/`
Expected: no changes shown — every SKILL.md was already up-to-date from per-service commits.

If any file shows as modified, the corresponding service task did not regenerate the file after its last edit. Inspect the diff and decide whether to amend (acceptable: a missed regeneration; not acceptable: a flag added in code but no example for it).

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 5: Run typecheck and build**

Run: `bun run typecheck && bun run build`
Expected: both succeed.

- [ ] **Step 6: Manual smoke test**

Run: `bun run dev gmail send --help`
Expected: standard help with an `Examples:` block.

Run: `bun run dev --help | tail -10`
Expected: at the bottom, the global footer mentioning `agentio skill <service>` and `agentio docs`. (If the footer is missing, add it: in `src/index-program.ts` after the last `register*Command(program)` call, add `program.addHelpText('after', '\nFor agent/LLM usage: run `agentio skill <service>` to dump a full SKILL.md, or `agentio docs` for the machine-readable command index.\n');`)

- [ ] **Step 7: Commit any remaining changes**

```bash
git add -A
git commit -m "chore(skill): final verification — all services have examples"
```

(If there is nothing to commit, skip this step.)

---

## Spec coverage check

- ✅ Per-leaf-command `addHelpText('after', ...)` source of truth — Tasks 4–30, via `addExamples()` helper (Task 1).
- ✅ Fixed `Examples:` format — enforced by Task 3's gate test (`firstNonBlank.trim() === 'Examples:'`).
- ✅ Top-level pointer in `agentio --help` — Task 31 step 6.
- ✅ Hidden `agentio skill <service>` command with `--all` and `--list` — Task 2.
- ✅ Six existing SKILL.md files regenerated and committed — Tasks 4–9.
- ✅ New SKILL.md files for services that previously lacked one — Tasks 10–30.
- ✅ CI gate test that fails when leaf commands lack examples — Task 3.
- ✅ Profile and hidden-command exemptions — Task 3 step 2 (`fullPath.includes(' profile ')`; hidden commands are filtered by `help.visibleCommands` upstream in `collectCommands`).
- ✅ Side-table extraction (no markdown parsing) — Task 1's `WeakMap<Command, string>`.
