# Schedule / Daemon Unification Design

**Date:** 2026-04-24
**Status:** Draft — pending user review

## Goal

Replace the current per-schedule launchd model with a single long-lived `agentio daemon` process that both:

1. Maintains real-time messaging connections (WhatsApp, Telegram) — today's gateway responsibilities.
2. Watches one or more folders and fires `*.run.md` schedules at the right time with the correct working directory.

The daemon is installed once per machine. Users add schedules by dropping `.run.md` files into watched folders; no per-schedule installation step. This works naturally across a Dropbox-synced folder (laptop edits, Mac mini runs).

## Motivating use case

- User edits `foo.run.md` on their laptop in `~/Dropbox/schedules/`.
- `~/Dropbox/schedules/` is synced to a Mac mini where `agentio daemon` runs 24/7.
- Within one minute of the file appearing on the Mac mini, the daemon picks it up, computes its next run, and fires it with `cwd = ~/Dropbox/schedules/`.
- The laptop never runs `agentio schedule add`.

## Non-goals

- Remote/cloud-hosted daemon orchestration (teleport stays but is not extended).
- Sub-minute scheduling precision (current schedule types are minute-granular; keep that).
- Cron expression support (the existing `Schedule` union is more constrained and that's intentional).
- Windows support (out of scope; today's code is macOS/Linux only).

## High-level architecture

```
┌──────────────────── agentio daemon (one process per machine) ────────────────────┐
│                                                                                  │
│   HTTP API (127.0.0.1:7890, API-key auth)                                        │
│   ├── /health, /status                                                           │
│   ├── /inbox/*, /outbox/*, /import/whatsapp/*       (unchanged)                  │
│   └── /scheduler/watch, /scheduler/list, /scheduler/reload   (new)               │
│                                                                                  │
│   Adapters          Scheduler tick (every 60s)                                   │
│   ├── WhatsApp      ├── rescan watched folders for *.run.md                      │
│   └── Telegram      ├── parse frontmatter                                        │
│                     ├── update in-memory schedule table                          │
│                     ├── compute next-fire for each schedule                      │
│                     └── spawn runSchedule() for due schedules                    │
│                                                                                  │
│   SQLite (gateway.db)  +  Config (config.daemon.scheduler.watchedFolders)        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Installation:

- macOS → `~/Library/LaunchAgents/me.agentio.daemon.plist` (user agent, no sudo)
- Linux → `/etc/systemd/system/agentio-daemon.service` (same as today, renamed)

## Components

### 1. Rename: `gateway` → `daemon`

Pure renaming pass. One-version read-compat for `config.gateway`.

- `src/commands/gateway.ts` → `src/commands/daemon.ts`
- `src/gateway/` → `src/daemon/` (internal module file `daemon.ts` keeps its name — `src/daemon/daemon.ts` — or is renamed to `runtime.ts` if the duplication reads poorly in imports; caller's choice at implementation time)
- CLI: `agentio gateway *` → `agentio daemon *`
- Config key: `config.daemon` (read: `config.daemon ?? config.gateway`; write: always `config.daemon`)
- systemd unit: `agentio-daemon.service` (label `agentio-daemon`)
- Launchd label: `me.agentio.daemon`
- SQLite file renamed on first startup: `~/.config/agentio/gateway.db` → `~/.config/agentio/daemon.db` (rename if only `gateway.db` exists; otherwise leave both and log a warning)
- Log file: `~/.config/agentio/gateway.log` → `~/.config/agentio/daemon.log` (same rename rule)
- `agentio gateway teleport` keeps its behavior under `agentio daemon teleport`.
- Docs (CLAUDE.md section, README, skills under `claude/skills/` referencing gateway) updated.

The `apiUrl` / `apiKey` / `server` / `webhook` / `media` / `retention` shapes under `config.daemon` are unchanged.

### 2. macOS installer for the daemon

New code path in `daemon install` that branches on `process.platform`:

- **darwin**: write `~/Library/LaunchAgents/me.agentio.daemon.plist`, then `launchctl bootstrap gui/<uid> <plist>` (fallback `launchctl load` for older macOS). Plist fields:
  - `Label = me.agentio.daemon`
  - `ProgramArguments = [<binaryPath>, "daemon", "start", "--foreground"]`
  - `RunAtLoad = true`
  - `KeepAlive = true`  *(restart on any exit — see "Open defaults" below)*
  - `StandardOutPath = ~/.config/agentio/daemon.log`
  - `StandardErrorPath = ~/.config/agentio/daemon.log`
  - `EnvironmentVariables = { HOME, PATH }` (inherited from user's login shell)
  - `WorkingDirectory = $HOME`
- **linux**: current systemd path, relabeled.
- **other platforms**: error with a clear message.

`daemon start / stop / restart / status / logs / uninstall` each branch the same way. On macOS: `launchctl`, `tail -f ~/.config/agentio/daemon.log` for `logs`, and `launchctl print gui/<uid>/me.agentio.daemon` parsing for `status`.

The HTTP health probe (`GET /health`) is the **primary** "is it running" check in `status` on both platforms. Platform-specific probes are secondary.

### 3. Scheduler inside the daemon

New module: `src/daemon/scheduler.ts`.

State:

```ts
interface WatchedFolder {
  path: string;           // absolute path
  host?: string;          // optional, pinned host; defaults to current hostname at watch-time
  addedAt: number;
}

interface ScheduledJob {
  folder: string;         // watched folder root
  id: string;             // filename without .run.md
  filePath: string;       // absolute path to the .run.md file
  config: FrontmatterConfig;
  nextRun: Date;
}

// In-memory only; source of truth is:
// - config.daemon.scheduler.watchedFolders  (persistent list of folders)
// - .run.md frontmatter                     (per-schedule config)
// - <folder>/.agentio/state.json            (lastRunAt per id)
```

Lifecycle inside `startDaemon()`:

1. On startup, load `config.daemon.scheduler.watchedFolders`.
2. Immediately run a `rescan()` (populate `ScheduledJob` table).
3. Run **missed-runs catch-up**: for each job, if `lastRunAt < previousExpectedRun`, fire it once (with a cap of one catch-up per id per startup; log `[scheduler] catch-up id=x skipped-runs=n`).
4. Start a 60-second tick interval that:
   - Re-walks all watched folders, detecting added / removed / modified `.run.md` files (cheap: `stat().mtime` on the file; re-parse only on change).
   - Fires any job whose `nextRun <= now`. On fire, spawn `runSchedule({ folder, id, promptBody, config, quiet: true })` **without awaiting** — runs are concurrent by folder/id. Update in-memory `nextRun` immediately using `nextRuns(config.schedule, 1)[0]`.
5. On shutdown (SIGINT/SIGTERM): let in-flight `runSchedule` processes finish (bounded by a short timeout, e.g. 30s), then exit.

Concurrency rule: if the same `(folder, id)` is already running when its next tick fires, **skip** the new fire and log `[scheduler] skipped id=x reason=still-running`. This prevents overlapping runs of the same schedule. Different ids run in parallel freely.

Host-pinning: when walking, skip any `.run.md` whose frontmatter `host:` does not match `getCurrentHost()`. This is the existing `hostMatches()` function — reused as-is.

Watched-folder pinning: `config.daemon.scheduler.watchedFolders[].host` is an additional, folder-level gate. If set and it doesn't match the current host, the entire folder is skipped. This is the default behavior when `schedule watch` is invoked (implicit pin to current host), giving the user the "laptop adds folder / Mac mini runs it" semantics out of the box.

### 4. New `schedule watch` command

```
agentio schedule watch <folder>         Register a folder for the local daemon to scan
agentio schedule unwatch <folder>       Remove a folder from the watch list
agentio schedule watched                List watched folders (and which host they're pinned to)
```

`watch` flow:

1. Resolve folder to absolute path; fail if it doesn't exist.
2. Append to `config.daemon.scheduler.watchedFolders` (dedup by path). Default `host` to `getCurrentHost()` unless `--no-host-pin` is passed.
3. Save config.
4. Try to reach `http://127.0.0.1:7890/scheduler/reload` with the API key:
   - **Daemon running** → reload succeeds, new folder picked up immediately. Print a summary of how many `.run.md` files were found.
   - **Daemon not running, installed** → print: "Watched folder added. Start the daemon to begin scheduling: `agentio daemon start`".
   - **Daemon not installed** → print: "The agentio daemon is not installed. Run `agentio daemon install` to install and start it." (in interactive mode, prompt: "Install now? [y/N]" and run the install inline on yes).
5. Regardless of daemon state, the folder is persisted in config — once the daemon comes up, it will find it.

### 5. Retire launchd-per-schedule

- `schedule add` is kept, but loses its plist side-effect. It becomes a pure frontmatter writer/installer into a folder. Message on save changes from "Installed plist…" to "Saved. Add the containing folder to a daemon watch list with `agentio schedule watch <folder>`" (unless the folder is already watched).
- `schedule sync` is kept and simplified: only reconciles frontmatter (prompts for missing fields). The plist-reconciliation block is deleted.
- `schedule remove` no longer uninstalls a plist; it just deletes the `.run.md` file.
- Files deleted: `src/services/schedule/launchd.ts`, `src/services/schedule/plist-builder.ts`, `src/services/schedule/folder-hash.ts`. Their tests are deleted or rewritten.

### 6. Migration: `schedule migrate`

New one-shot command: `agentio schedule migrate`. For users upgrading from the plist-based world:

1. Enumerate all existing `me.agentio.schedule.*` plists under `~/Library/LaunchAgents/`.
2. Group by folder (extracted from `ProgramArguments`).
3. For each folder: `launchctl unload` + `rm` every matching plist.
4. For each distinct folder, run `schedule watch <folder>` (pinned to current host).
5. Print a summary: "Migrated N schedules across M folders. Run `agentio daemon install` if the daemon isn't already installed."

If no legacy plists are found, print "Nothing to migrate" and exit 0.

This command is mentioned in the first-run / upgrade notes but never auto-runs — the user invokes it explicitly.

### 7. HTTP API additions

All require `X-API-Key` (existing auth).

- `POST /scheduler/reload` — re-read `config.daemon.scheduler.watchedFolders` and rescan. Returns `{ folders: number, jobs: number }`.
- `GET /scheduler/list` — returns `{ jobs: [{ folder, id, schedule, enabled, nextRun, lastRunAt, lastExitCode, isRunning }] }`. Used by `schedule list` when the daemon is running (falls back to filesystem-only view when it's not).
- `POST /scheduler/run` — `{ folder, id }` → fire a job immediately (used by `schedule run` once the daemon is running, to avoid re-implementing spawn logic in the CLI). Returns the same shape as `/scheduler/list` for that job.

### 8. `schedule list` behavior

- If daemon is running: hit `/scheduler/list`, render the enriched table (includes `nextRun`, `lastRunAt`, `isRunning`).
- If daemon is not running: fall back to filesystem-only walk of watched folders (from config). Columns with daemon-only data show `-`.

### 9. `schedule run <id>` behavior

- If daemon is running: delegate to `POST /scheduler/run`. The daemon spawns the child, the CLI streams its log tail until the run completes.
- If daemon is not running: run locally in the current process (existing `runSchedule()` path). This keeps ad-hoc testing working even without a daemon.

## Data flow

### Add a schedule on laptop, run it on Mac mini

1. User runs `agentio schedule add weekly-report.run.md --folder ~/Dropbox/schedules --schedule weekly --weekdays mon --at 09:00` on laptop.
   - Writes frontmatter into the file. No plist. Prints a reminder to watch the folder on the target machine.
2. Dropbox syncs the file to Mac mini.
3. Mac mini's `agentio daemon` has `~/Dropbox/schedules` in its `watchedFolders` (set up once, earlier). On its next 60s tick, it picks up the new `.run.md`, parses the frontmatter, and schedules it.
4. At Monday 09:00 local Mac mini time, the scheduler fires `runSchedule({ folder: ~/Dropbox/schedules, id: weekly-report, ... })`. Logs go to `~/Dropbox/schedules/.agentio/runs/weekly-report/*.log` (existing layout).

### Missed-runs catch-up

1. Mac mini is asleep from 03:00 to 09:00. A schedule was due to fire at 07:00.
2. On wake, launchd restarts `agentio daemon` (KeepAlive). Actually, `KeepAlive=true` doesn't wake the Mac; it only keeps the process alive once running. For most Mac minis that stay awake this is fine. For sleep-prone machines we rely on catch-up.
3. On startup, `scheduler.ts` reads `.agentio/state.json`, sees `lastRunAt = yesterday-09:00`, computes that the expected run was at `today-07:00`, fires it once.
4. Cap: no more than **one** catch-up fire per id per startup. If multiple runs were missed, only one executes; the rest are logged as skipped.

## Config shape

```jsonc
{
  "profiles": { /* unchanged */ },
  "daemon": {
    // All existing GatewayConfig fields preserved verbatim:
    "name": "mac-mini",
    "apiKey": "gw_...",
    "server": { "port": 7890, "host": "0.0.0.0" },
    "webhook": { /* ... */ },
    "media": { /* ... */ },
    "retention": { /* ... */ },
    // New:
    "scheduler": {
      "watchedFolders": [
        { "path": "/Users/plosson/Dropbox/schedules", "host": "mac-mini", "addedAt": 1745500000000 }
      ],
      "tickIntervalSec": 60
    }
  }
}
```

## Error handling

- **Walk errors** (folder unreadable, deleted): log `[scheduler] walk failed <path>: <err>`, skip that folder for this tick. Next tick re-tries.
- **Frontmatter parse errors**: log, skip the file. Do not fire. Do not remove from in-memory table (user may fix the file and the next tick will re-parse).
- **Spawn failures**: existing `runSchedule()` writes a failure summary; no daemon-level change.
- **API reload failure from `schedule watch`**: non-fatal — config is saved, message to the user explains how to start the daemon.
- **Unknown platform on `daemon install`**: fail with a clear message. Do not attempt silent fallback.
- **Port conflict**: existing behavior preserved (daemon start fails fast with a readable error).

## Testing

Retain the existing test style: pure modules (walker, frontmatter, schedule-calculator, host, duration, weekdays) already have unit tests; keep them untouched.

New tests:

- `scheduler.ts`: tick logic with a frozen clock and an injectable filesystem + spawner. Cover: basic fire, missed-runs catch-up (one-cap), concurrency skip (same id twice), host-pinned-folder skip, host-pinned-file skip, frontmatter-parse-error skip, delete-file-between-ticks removal.
- `daemon install` on darwin: plist content generation + `launchctl bootstrap` invocation (mock the exec).
- `schedule watch` / `unwatch` / `watched`: config persistence + API-reload probe (mock fetch, cover all three branches: running, installed-but-stopped, not-installed).
- `schedule migrate`: enumerate mock LaunchAgents dir, assert unload+unlink calls, assert watched folders added.

Delete tests for `launchd.ts`, `plist-builder.ts`, `folder-hash.ts`.

## Open defaults (calling out the judgement calls)

1. **`KeepAlive=true`** on macOS: restart the daemon on any exit. Chosen for Mac-mini-always-on use case. If crash-loops become a problem, future change to `KeepAlive = { SuccessfulExit = false, Crashed = true }`.
2. **60-second tick interval**: hardcoded default, overridable via `config.daemon.scheduler.tickIntervalSec`. Low enough that newly-dropped files feel instant; high enough that filesystem walk cost is trivial.
3. **Missed-runs cap of 1**: for a schedule that's missed 12 fires, one catch-up is better than a flood. A future `--catch-up-all` flag could relax this if users want it.
4. **Implicit host pin on `schedule watch`**: the folder is pinned to the current hostname by default. Prevents the laptop-also-running-a-daemon double-fire. Explicit override: `schedule watch <folder> --no-host-pin`.
5. **`schedule run <id>` delegation to the daemon when it's running**: keeps logs in one place and matches expected semantics (the daemon is the runner). Ad-hoc local runs still work when the daemon is down.

## Out of scope for this spec (future work)

- File-watching via `fs.watch` / FSEvents instead of polling. Polling is simpler and robust against network filesystems (Dropbox, iCloud); can be added later if the 60s latency is unacceptable.
- Multiple daemons per machine (e.g. different API keys for different users). One daemon per machine, shared across the user's projects.
- Remote scheduler API (triggering a remote daemon's schedules from another machine). `teleport` stays as-is for auth state only.
- Windows support.

## Rollout

This is a breaking change internally but we can ship it with:

- `schedule add` keeps its CLI shape; just loses the plist side-effect.
- `gateway` commands alias to `daemon` for one minor version with a stderr deprecation warning, then removed.
- `config.gateway` readable for one minor version, always re-written as `config.daemon`.
- `schedule migrate` provides a clean path for existing users.
- CHANGELOG entry under `0.17.0` (or whatever bump applies).
