---
name: agentio-schedule
description: Use to manage agentio scheduled .run.md prompts in watched folders.
---

# Schedule via agentio

Auto-generated from `agentio skill schedule`. Do not edit by hand.

## agentio schedule watch <folder>

Watch a folder for .run.md files

Options:

- `--no-host-pin`: Do not pin this folder to the current host

```
Examples:

  # watch a folder of .run.md files (pinned to this hostname by default)
  agentio schedule watch ~/Dropbox/schedules

  # watch but allow any host to fire (for non-Dropbox-synced folders)
  agentio schedule watch ./agents --no-host-pin

After watching, author .run.md files in the folder directly. The daemon picks
them up via fs.watch within ~500ms. Run 'agentio schedule list' to confirm.
```

## agentio schedule create [name]

Create a new .run.md schedule (interactive, or non-interactive with flags)

Options:

- `--folder <path>`: Directory to create the file in (default: .)
- `--schedule <type>`: manual | daily | weekly | monthly | interval
- `--at <HH:MM>`: Time of day (daily/weekly/monthly)
- `--hour <n>`: Hour 0-23 (alternative to --at)
- `--minute <n>`: Minute 0-59 (alternative to --at)
- `--weekdays <list>`: Weekdays for weekly, e.g. mon,fri or 1,5
- `--day <n>`: Day of month 1-31 (monthly)
- `--interval <dur>`: Interval, e.g. 30m, 2h, 1h30m
- `--model <model>`: opus | sonnet | haiku (default: sonnet)
- `--permission-mode <mode>`: default | bypass | plan | accept-edits (default: bypass)
- `--host <name>`: Host to pin the schedule to (default: this hostname)
- `--command <cmd>`: Run a shell command instead of claude
- `--prompt <text>`: Prompt body for claude (or pipe via stdin)
- `--prompt-file <path>`: Read the prompt body from a file
- `--disabled`: Create the schedule disabled (enabled: false)
- `--watch`: Also register the folder with the daemon
- `-y, --yes`: Non-interactive: use flags + defaults, do not prompt
- `--force`: Overwrite the file if it already exists

```
Examples:

  # interactive — walks you through every field
  agentio schedule create

  # non-interactive: a daily 9am job in the current folder
  agentio schedule create morning-brief --schedule daily --at 09:00 \
    --prompt "Summarize my unread email and post it to Slack" -y

  # weekly on Mon+Fri, pipe the prompt in, and start watching the folder
  echo "Weekly report" | agentio schedule create weekly-report \
    --folder ~/Dropbox/schedules --schedule weekly --weekdays mon,fri \
    --at 08:00 --watch -y

  # every 30 minutes, running a shell command instead of claude
  agentio schedule create ping --schedule interval --interval 30m \
    --command "curl -fsS https://example.com/health" -y

Created files only fire once their folder is watched (see --watch and
'agentio schedule watch'). Author or refine the prompt body in the file after.
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

## agentio schedule doctor

Check that the claude CLI is installed and logged in (runs a trivial prompt)

Options:

- `--model <model>`: Model for the smoke test (opus|sonnet|haiku) (default: haiku)
- `--timeout <seconds>`: Seconds to wait for the test prompt (default: 60)

```
Examples:

  # verify the daemon will be able to run claude
  agentio schedule doctor

  # test with a specific model and a longer timeout
  agentio schedule doctor --model sonnet --timeout 90

This runs a trivial prompt through the same login-shell environment the daemon
uses, so a green result means scheduled .run.md jobs can launch claude.
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
