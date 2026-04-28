---
name: agentio-schedule
description: Use when scheduling Claude Code prompts to run on a cron-like schedule locally via the agentio daemon. Watch folders containing .run.md files; the CLI handles folder registration, the user authors files in their text editor.
---

# Scheduling Claude Prompts with agentio

The **agentio daemon** scans watched folders every minute and fires due `.run.md` schedules. There are no per-schedule launchd plists; the daemon itself runs as a single LaunchAgent (macOS) or systemd unit (Linux).

The CLI manages **folder registration only**. Users author `.run.md` files directly in their text editor.

## Prerequisites

Install and start the daemon once per machine:

```bash
agentio daemon install   # macOS: ~/Library/LaunchAgents/me.agentio.daemon.plist
                         # Linux: /etc/systemd/system/agentio-daemon.service
agentio daemon status
```

## Watch a folder

```bash
agentio schedule add ~/Dropbox/schedules    # watch this folder
agentio schedule list                       # show watched folders + detected schedules
agentio schedule remove ~/Dropbox/schedules # stop watching
```

By default `add` pins the folder to the current hostname (so a Dropbox-synced folder fires only on the machine that watched it). Pass `--no-host-pin` to allow any machine to run it.

## Author a `.run.md` file

Create a file like `~/Dropbox/schedules/weekly-report.run.md` in your editor:

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
host: mac-mini
---

Your prompt text here. Everything below the `---` is sent to claude as-is.
```

**`host:` is required.** The daemon skips schedules without a host. This prevents Dropbox-synced folders from double-firing across machines.

Schedule types:

| type | required fields |
|------|-----------------|
| `daily` | `hour`, `minute` |
| `weekly` | `hour`, `minute`, `weekdays: [1,3,5]` (1=Mon, 7=Sun) |
| `monthly` | `hour`, `minute`, `day` (1-31) |
| `interval` | `intervalMinutes` |
| `manual` | (no auto-fire; only via `schedule run`) |

Setting `enabled: false` pauses without deleting. `sessionMode: resume` continues the previous session on the next run.

## Inspect / run

```bash
agentio schedule list                # all watched folders + their schedules
agentio schedule list --all-hosts    # also show schedules pinned to other machines
agentio schedule show <id>           # one schedule's frontmatter + next 5 run times
agentio schedule run <id>            # fire now (ignores host pinning — manual runs work anywhere)
agentio schedule history             # last run of every job across watched folders
agentio schedule history <id>        # all runs of one schedule
```

The id-based commands (`show`, `run`, `history <id>`) resolve `<id>` by scanning watched folders — the current working directory is irrelevant. Use `--folder <path>` only to disambiguate when the same id exists in multiple watched folders.

Logs land in `<folder>/.agentio/runs/<id>/<ISO>.log`.

## How firing works

- The daemon watches each registered folder via `fs.watch` and re-ticks within ~500ms of any `.run.md` change. A 60-second timer (configurable via `config.daemon.scheduler.tickIntervalSec`) provides the safety net.
- On each tick, it walks every watched folder, parses every `.run.md`, computes the most recent boundary (`prevRun`), and fires any schedule whose `lastRunAt` is older than that boundary (or absent — first run).
- Schedules naturally catch up if the daemon was off when a fire was due (one catch-up per missed boundary).
- A schedule already running is skipped on the next tick (no overlapping same-id runs).
- A schedule whose `host:` doesn't match the current hostname is skipped silently.
