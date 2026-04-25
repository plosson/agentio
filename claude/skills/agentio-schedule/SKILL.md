---
name: agentio-schedule
description: Use when scheduling Claude Code prompts to run on a cron-like schedule locally via the agentio daemon. Add, list, run, and watch folders containing *.run.md files.
---

# Scheduling Claude Prompts with agentio

Use `agentio schedule` to run prompts on a schedule. Each schedule is a `<id>.run.md` file with YAML frontmatter + a prompt body. The **agentio daemon** scans watched folders every minute and fires due schedules. There are no per-schedule launchd plists; the daemon itself runs as a single LaunchAgent (macOS) or systemd unit (Linux).

## Prerequisites

Install and start the daemon once per machine:

```bash
agentio daemon install   # macOS: ~/Library/LaunchAgents/me.agentio.daemon.plist
                         # Linux: /etc/systemd/system/agentio-daemon.service
agentio daemon status
```

## Add a schedule

```bash
agentio schedule add prompts/mytask.run.md \
  --schedule daily --at 21:00 \
  --model sonnet --permission-mode bypass -y
```

This writes the frontmatter into the file. **The daemon will not pick it up until the containing folder is watched** (next section).

Schedule types: `manual | daily | weekly | monthly | interval`.

| type | flags |
|------|-------|
| `daily` | `--at HH:MM` |
| `weekly` | `--weekdays mon,wed,fri --at HH:MM` |
| `monthly` | `--day 15 --at HH:MM` |
| `interval` | `--interval 30m` (`2h`, `1h30m`) |
| `manual` | none — only fires when invoked via `schedule run` |

## Watch a folder

Tell the daemon to scan a folder for `.run.md` files:

```bash
agentio schedule watch ~/Dropbox/schedules
agentio schedule watched          # list watched folders
agentio schedule unwatch <folder> # stop watching
```

By default `watch` pins the folder to the current hostname (so a Dropbox-synced folder fires only on the machine that watched it). Pass `--no-host-pin` to allow any machine to run it.

## Run now

```bash
agentio schedule run mytask
```

If the daemon is running, this delegates to it via the API. Otherwise it runs locally in the foreground. Logs land in `<folder>/.agentio/runs/mytask/<ISO>.log` either way.

## List / show / remove

```bash
agentio schedule list             # delegates to daemon when running, falls back to filesystem view
agentio schedule show mytask
agentio schedule remove mytask    # deletes the .run.md file
```

## Validate a folder

Useful before committing a folder of `.run.md` files, or after editing them by hand:

```bash
agentio schedule sync             # checks id collisions + frontmatter completeness; scaffolds .agentio/.gitignore
```

## Migrating from the old per-schedule launchd model

If you have legacy `me.agentio.schedule.*.plist` files in `~/Library/LaunchAgents/` from older agentio versions:

```bash
agentio schedule migrate
```

One-shot: removes the legacy plists, extracts their folders, and adds them to the daemon's watch list.

## Pin a schedule to one machine

Two layers of host pinning:

1. **Folder-level** (set by `schedule watch <folder>` by default): the daemon on this machine watches; daemons on other machines ignore the folder.
2. **File-level** (frontmatter `host:` field): even if a folder is watched on multiple machines, this schedule only fires on a hostname match.

```bash
agentio schedule add prompts/backup.run.md \
  --schedule daily --at 02:00 --host mac-mini -y
```

`agentio schedule run <id>` ignores host pinning — manual runs work anywhere.

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
# host: mac-mini   # optional; only fires on this hostname
---

Your prompt text here. Everything below the `---` is sent to claude as-is.
```

Setting `enabled: false` pauses the schedule without deleting the file. `sessionMode: resume` continues the previous session on the next run.

## How firing works

- The daemon ticks every 60 seconds (configurable via `config.daemon.scheduler.tickIntervalSec`).
- On each tick, it walks every watched folder, parses every `.run.md`, computes the most recent boundary (`prevRun`), and fires any schedule whose `lastRunAt` is older than that boundary (or absent — i.e. first run).
- This means schedules naturally catch up if the daemon was off when a fire was due (one catch-up per missed boundary).
- A schedule that's already running is skipped on the next tick (no overlapping runs of the same id).
