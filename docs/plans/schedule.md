# agentio schedule - Design

## Overview

`agentio schedule` lets the user register Claude Code prompts (or arbitrary commands) to run on a schedule via macOS `launchd`. Each schedule is a markdown file named `<id>.run.md` containing YAML frontmatter (schedule + Claude config) and a prompt body. The launchd plist is derived state; the `.run.md` files are the source of truth.

Inspired by [claude-cron](https://github.com/plosson/claude-cron) (native macOS GUI app), reduced to a CLI-only surface.

## Goals

- **Per-folder, git-committable schedules.** Commit `*.run.md` files to a repo; anyone who clones it can `agentio schedule sync` and install the schedules on their machine.
- **No central agentio registry.** launchd is the index of "what's currently scheduled on this machine"; `*.run.md` files are the index of "what this folder defines".
- **CLI-first, interactive fallback.** Every option has a flag for non-interactive / scripted use; missing fields fall through to interactive prompts only when stdin is a TTY.

## Non-goals (for v1)

- Linux support (cron/systemd). Targeted for a later iteration.
- Inline prompts. Prompts always live in a file.
- Run history UI / log tail streaming. `runs` just lists per-run log files.
- Notifications on run start/complete. Out of scope.
- Profile support. Schedules are folder-scoped; no credentials involved.

## Architecture

### Storage model

- **`<folder>/<path>/<id>.run.md`** — the schedule definition. Anywhere in the folder subtree. User-owned, git-committable.
  - YAML frontmatter: schedule type, timing, model, permission mode, session mode, enabled flag, optional command override.
  - Body: the prompt text.
- **`~/Library/LaunchAgents/me.agentio.schedule.<folder-hash>-<id>.plist`** — launchd job. Derived state.
  - `Label`: `me.agentio.schedule.<folder-hash>-<id>`
  - `ProgramArguments`: `["/bin/zsh", "-lic", "agentio schedule run <id> --folder <abs-folder> --from-launchd"]`
  - Trigger keys (`StartCalendarInterval` / `StartInterval`) generated from frontmatter.
  - Manual schedules still install a plist (as an index marker) with no trigger.
- **`<folder>/.agentio/state.json`** — machine-managed runtime state per id: `sessionId`, `lastRunAt`. Gitignored.
- **`<folder>/.agentio/runs/<id>/<ISO-timestamp>.log`** — per-run output. Gitignored.
- **`<folder>/.agentio/.gitignore`** — auto-created on first install, ignoring `runs/` and `state.json`.

### Frontmatter schema

```markdown
---
schedule:
  type: daily                 # manual | daily | weekly | monthly | interval
  hour: 21
  minute: 0
  # weekdays: [1, 3, 5]       # weekly only (1=Mon, 7=Sun)
  # day: 15                   # monthly only
  # intervalMinutes: 60       # interval only
model: sonnet                 # opus | sonnet | haiku
permissionMode: bypassPermissions   # default | bypassPermissions | plan | acceptEdits
sessionMode: new              # new | resume | fork
enabled: true
# command: "bun run backup.ts"  # optional; when set, model/permissionMode/sessionMode are ignored at run-time
---

Your prompt body here.
Multi-line markdown is fine.
```

### Identity

- `id` = filename basename without `.run.md` suffix.
- A given folder tree must contain at most one file per `id` (collision check in `sync`).
- External addressing: CWD by default; `--folder <path>` to target another folder.
- Machine-wide: `(folder-abs-path, id)`, encoded in each plist's Label (via `folder-hash = djb2(folder-abs-path)`) and ProgramArguments.

## Commands

```
agentio schedule add <file.run.md> [flags]       # scaffold or update, then sync
agentio schedule list [--folder <path>]          # enumerate installed plists (all, or for one folder)
agentio schedule sync [--folder <path>] [-y]     # reconcile launchd state with *.run.md files
agentio schedule remove <id> [--folder <path>]   # delete the .run.md file + sync
agentio schedule run <id> [--folder <path>]      # run now (manual trigger); also used by launchd
agentio schedule show <id> [--folder <path>]     # print frontmatter + next N run times
agentio schedule runs <id> [--folder <path>]     # list past run log files
```

### `schedule add <file.run.md>`

Positional: path to the `.run.md` file (relative to `--folder`, which defaults to CWD). Must end in `.run.md`.

Flags:

```
--schedule <type>          manual | daily | weekly | monthly | interval
--at <HH:MM>               shortcut for --hour/--minute
--hour <0-23>              (overrides --at)
--minute <0-59>
--weekdays <list>          weekly only; mon,wed,fri or 1,3,5
--day <1-31>               monthly only
--interval <duration>      interval only; 30m, 2h, 1h30m
--model <m>                opus | sonnet | haiku              (default: sonnet)
--permission-mode <m>      default | bypass | plan | accept-edits  (default: bypass)
--session-mode <m>         new | resume | fork                (default: new)
--command <cmd>            optional command override
--disabled                 create with enabled: false
--yes / -y                 non-interactive; error if required flags missing
--folder <path>            defaults to CWD
```

Required per schedule type:

| type | required |
|------|----------|
| `manual` | - |
| `daily` | `--at` (or `--hour` + `--minute`) |
| `weekly` | `--weekdays`, `--at` |
| `monthly` | `--day`, `--at` |
| `interval` | `--interval` |

Resolution:

1. If `<file>` does not exist, scaffold it with a placeholder body (`# TODO: write your prompt here`). If it exists without frontmatter, start from empty config. If it exists with frontmatter, load it as the starting point.
2. Apply any CLI flag as an override.
3. For any remaining required field: prompt interactively (TTY, no `-y`), or error (no-TTY or `-y`).
4. Validate the final config; apply defaults for optional fields (`model`, `permissionMode`, `sessionMode`, `enabled`).
5. Write merged frontmatter back to `<file>` (preserving any existing body).
6. Call `sync` for this folder to install/update the plist.

### `schedule sync [--folder] [--yes]`

Reconciles launchd state with the `*.run.md` files in the folder.

1. Walk the folder tree for `*.run.md` files. (Skips `node_modules`, `.git`, and `.agentio/runs/`.)
2. For each file:
   - Parse frontmatter. If missing or incomplete → prompt interactively (TTY, no `-y`) and write back. Non-interactive → error listing the incomplete files and skip.
   - Compute the desired plist dict.
3. Enumerate existing agentio plists for this folder (Label prefix `me.agentio.schedule.<folder-hash>-`).
4. Diff:
   - **Files with no plist** → install.
   - **Plists with no file** → orphans → uninstall + delete plist.
   - **Both exist but dict differs** (including `enabled: false`, trigger-key changes) → re-install.
   - **Both exist and dict matches** → no-op.
5. Collision check: two files resolving to the same `id` → error with both paths; no changes applied.
6. On first install in a folder, write `.agentio/.gitignore` (`runs/`, `state.json`) if it doesn't exist.

### `schedule list [--folder]`

- Without `--folder`: enumerate all plists matching `me.agentio.schedule.*` across the machine; group by folder.
- With `--folder`: filter by folder hash.
- For each plist, locate the `<id>.run.md` file (glob within folder); if missing, mark entry as `[broken]`.
- Output columns: folder, id, schedule summary ("Daily at 21:00"), model, next run, enabled.

### `schedule remove <id> [--folder]`

1. Resolve the file by globbing `<folder>/**/<id>.run.md`.
2. Delete the file.
3. Run `sync` (which uninstalls the now-orphaned plist).

### `schedule run <id> [--folder] [--from-launchd]`

Manual trigger (also how launchd invokes schedules).

1. Glob `<folder>/**/<id>.run.md`. Error if 0 or >1 matches.
2. Parse frontmatter + extract prompt body.
3. Create log file `<folder>/.agentio/runs/<id>/<ISO-timestamp>.log`.
4. Spawn claude (or `command` if set) in `<folder>`. See "Claude invocation" below.
5. Stream output to the log. On `system/init` JSON event, capture `session_id` and write to `.agentio/state.json`.
6. Write a final summary line to the log as a single JSON object on the last line (machine-parseable by `schedule runs`):
   ```
   {"type":"summary","status":"succeeded|failed|cancelled","exitCode":0,"durationMs":12345,"sessionId":"...","startedAt":"...","endedAt":"..."}
   ```
7. Exit with the child's exit code.

Concurrent runs of the same `id` are allowed (no locking). If the user wants serial behavior, they can set `sessionMode: resume` and accept whatever launchd queues.

### `schedule show <id>`

Prints the parsed frontmatter + the next 5 scheduled run times (computed from schedule fields).

### `schedule runs <id>`

Lists entries in `.agentio/runs/<id>/` sorted newest first: timestamp, duration, exit code, session id (parsed from the log's final summary line).

## launchd details

### Plist trigger keys

| schedule type | launchd keys |
|---------------|--------------|
| `manual` | none (plist exists as an index marker; `RunAtLoad: false`) |
| `daily` | `StartCalendarInterval: { Hour, Minute }` |
| `weekly` | `StartCalendarInterval: [ { Weekday, Hour, Minute }, ... ]` (one dict per weekday; launchd weekday: 0=Sun..6=Sat, so convert from 1=Mon..7=Sun) |
| `monthly` | `StartCalendarInterval: { Day, Hour, Minute }` |
| `interval` | `StartInterval: <seconds>` |

### Install / uninstall

- **Install**: write plist XML to `~/Library/LaunchAgents/<label>.plist`; `launchctl load <path>`. On failure, remove the plist and throw `CONFIG_ERROR`.
- **Uninstall**: `launchctl unload <path>` (ignore errors if already unloaded); remove the plist file.
- Plist is only loaded via `launchctl load`; we don't touch `launchctl bootstrap` / domain-based APIs. (Same approach as claude-cron.)

### folder-hash

djb2 of the absolute folder path, hex-encoded. Matches claude-cron's Label-hashing approach. Short and deterministic.

### StandardOutPath / StandardErrorPath

Both point to `<folder>/.agentio/runs/<id>/launchd.log` (append mode). This is distinct from per-run logs; it captures launchd-level stderr / early boot issues before `agentio schedule run` can redirect.

## Claude invocation

Ported from claude-cron's `ClaudeService`:

1. **Locate claude binary**: run `/bin/zsh -lic 'which claude'` once per process; cache the result. If not found, check `~/.claude/local/bin/claude`, `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`. Error with a clear message if none exist.
2. **Environment**: inherit the cached login-shell env (`/bin/zsh -lic env`), stripping `CLAUDECODE`.
3. **Working directory**: the folder.
4. **Arguments**:
   ```
   claude --print --output-format stream-json --verbose --model <model>
          [--dangerously-skip-permissions | --permission-mode <plan|acceptEdits>]
          [--resume <sid> [--fork-session]]
          <prompt-body>
   ```
5. **Stream handling**: read stdout line-by-line; parse each line as JSON:
   - On `{"type": "system", "subtype": "init", "session_id": "..."}` → record `sessionId` in `.agentio/state.json`.
   - On `{"type": "result", "result": "..."}` → that's the final assistant output.
6. **Exit**: when the child exits, write a final summary line to the log; propagate exit code.

### Command override

If frontmatter has `command: "..."`, we skip claude entirely and spawn the command via `/bin/zsh -lic '<command>'` in the folder. `model`, `permissionMode`, `sessionMode`, `sessionId` are ignored.

## Error handling

Uses existing `CliError`:

| scenario | code |
|----------|------|
| id not found / file missing | `NOT_FOUND` |
| frontmatter parse error, unknown schedule type, bad weekday list | `INVALID_PARAMS` |
| required flag missing with `-y` or no TTY | `INVALID_PARAMS` |
| `.agentio/` can't be written | `CONFIG_ERROR` |
| `launchctl load` fails | `CONFIG_ERROR` (rolled back: plist removed) |
| claude binary not found | `NOT_FOUND` |
| two files resolve to same id in one folder | `INVALID_PARAMS` (lists both paths) |
| prompt file referenced by plist is missing (broken) | warning in `list`; `sync` prunes the orphan |

## File layout in agentio

```
src/types/schedule.ts                # Frontmatter type, schedule-type union, state-file type
src/services/schedule/
  frontmatter.ts                     # parse/serialize via gray-matter
  launchd.ts                         # plist dict builder, install/uninstall, enumerate by label prefix
  folder-hash.ts                     # djb2
  duration.ts                        # parse "30m" / "1h30m" / "2h"
  weekdays.ts                        # parse "mon,wed" / "1,3,5"
  schedule-calculator.ts             # next N run times (port from claude-cron ScheduleCalculator)
  state.ts                           # read/write .agentio/state.json
  runs.ts                            # enumerate .agentio/runs/<id>/ entries, parse summary
  claude-binary.ts                   # locate + invoke claude CLI (port from claude-cron ClaudeService)
  runner.ts                          # orchestrates schedule run <id>: spawn, stream, log, state update
src/commands/schedule.ts             # registerScheduleCommands(): all subcommands + flag parsing
```

Registered in `src/index.ts` alongside the other service commands (agentio utilities section).

### New dependency

- `gray-matter` — frontmatter parsing. Small, no transitive bloat.

## Testing

Unit tests (under `src/commands/` or `src/services/schedule/`):

- `frontmatter.ts` — round-trip parse/serialize; missing schedule block; unknown schedule type; preserves prompt body.
- `launchd.ts` — plist dict generation for all 5 schedule types; weekday conversion (Mon=1 → launchd 1); label generation.
- `duration.ts` / `weekdays.ts` — parsers with valid and invalid inputs.
- `schedule-calculator.ts` — next run times for each schedule type; DST boundary sanity check.
- `state.ts` — read missing file returns empty; corrupt file handled.

Integration-style (using tmp directories, mocking `launchctl` via a stub):

- `schedule add` end-to-end: writes frontmatter, calls sync, the computed plist dict matches expected.
- `schedule sync` diffs: install missing, remove orphans, update on frontmatter change.
- `schedule run`: spawn a stub child, stream faked stream-json output, session id captured.

`launchctl` is not invoked in tests; the `launchd` service module exposes a builder that returns the plist dict (pure function), and a separate thin wrapper that calls `launchctl` — only the builder is tested.

## Future work (not v1)

- Linux backend (systemd --user timers or cron).
- `agentio schedule enable/disable <id>` convenience (edits `enabled` + syncs).
- `agentio schedule logs <id> [--follow]` to tail the latest run.
- Watchdog: detect schedules that have been failing N runs in a row; surface in `list`.
