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
