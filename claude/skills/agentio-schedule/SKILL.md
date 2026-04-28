---
name: agentio-schedule
description: Use to manage agentio scheduled .run.md prompts in watched folders.
---

# Schedule via agentio

Auto-generated from `agentio skill schedule`. Do not edit by hand.

## agentio schedule add <folder>

Watch a folder for .run.md files

Options:

- `--no-host-pin`: Do not pin this folder to the current host

```
Examples:

  # watch a folder of .run.md files (pinned to this hostname by default)
  agentio schedule add ~/Dropbox/schedules

  # watch but allow any host to fire (for non-Dropbox-synced folders)
  agentio schedule add ./agents --no-host-pin

After adding, author .run.md files in the folder directly. The daemon picks
them up via fs.watch within ~500ms. Run 'agentio schedule list' to confirm.
```

## agentio schedule list

List watched folders and scheduled tasks

Options:

- `--folder <path>`: Filter schedules to one folder
- `--folders`: Show watched folders only (no schedules)
- `--all-hosts`: Include schedules pinned to other hosts

```
Examples:

  # watched folders + their detected schedules (host-pinned only)
  agentio schedule list

  # also show schedules pinned to other machines (Dropbox-shared folders)
  agentio schedule list --all-hosts

  # only schedules in one specific folder
  agentio schedule list --folder ~/Dropbox/schedules

  # just the watched-folder list, no schedule scan
  agentio schedule list --folders
```

## agentio schedule show <id>

Show a schedule and next run times

Options:

- `--folder <path>`: Restrict resolution to this folder

```
Examples:

  # frontmatter + next 5 fire times for one schedule (id is the .run.md basename)
  agentio schedule show weekly-report

  # disambiguate when the same id exists in multiple watched folders
  agentio schedule show weekly-report --folder ~/Dropbox/schedules
```

## agentio schedule run <id>

Run a schedule immediately

Options:

- `--folder <path>`: Restrict resolution to this folder
- `-q, --quiet`: Suppress streaming child output to stdout/stderr (used when invoked by the daemon)

```
Examples:

  # fire a schedule now (delegates to the daemon if running, else runs in-process)
  agentio schedule run weekly-report

  # restrict id resolution to one watched folder
  agentio schedule run weekly-report --folder ~/Dropbox/schedules

Manual runs ignore the host pin — useful for testing on a machine that isn't
the schedule's normal home.
```

## agentio schedule history [id]

List past runs (no id: last run of every job; with id: all runs of that job)

Options:

- `--folder <path>`: Restrict to one folder

```
Examples:

  # overview: last run of every job across all watched folders
  agentio schedule history

  # full run history for one schedule (newest first)
  agentio schedule history weekly-report

  # restrict the overview to one folder
  agentio schedule history --folder ~/Dropbox/schedules

Per-run logs land in <folder>/.agentio/runs/<id>/<ISO>.log.
```

## agentio schedule remove <folder>

Stop watching a folder

```
Examples:

  # stop watching a folder (existing .run.md files are not deleted)
  agentio schedule remove ~/Dropbox/schedules
```

