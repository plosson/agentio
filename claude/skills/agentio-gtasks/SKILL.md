---
name: agentio-gtasks
description: Use when interacting with Google Tasks via the agentio CLI.
---

# Gtasks via agentio

Auto-generated from `agentio skill gtasks`. Do not edit by hand.

## agentio gtasks lists list

List all task lists

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Max results (default: 100)

```
Examples:

  # show all your task lists with IDs
  agentio gtasks lists list

  # cap at a smaller number
  agentio gtasks lists list --limit 10
```

## agentio gtasks lists create

Create a new task list

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # create a new top-level task list
  agentio gtasks lists create "Groceries"

  # title with spaces (quote it)
  agentio gtasks lists create "Q4 Roadmap"
```

## agentio gtasks lists delete

Delete a task list

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # delete a list (irreversible — deletes all its tasks)
  agentio gtasks lists delete MTIzNDU2Nzg5MA
```

## agentio gtasks list

List tasks in a task list

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Max results (default: 20)
- `--show-completed`: Include completed tasks (default: true)
- `--no-show-completed`: Exclude completed tasks
- `--show-hidden`: Include hidden tasks
- `--due-min <datetime>`: Filter: due date minimum (RFC3339)
- `--due-max <datetime>`: Filter: due date maximum (RFC3339)

```
Examples:

  # tasks in a list (default: includes completed)
  agentio gtasks list MTIzNDU2Nzg5MA

  # only outstanding work
  agentio gtasks list MTIzNDU2Nzg5MA --no-show-completed

  # tasks due this week
  agentio gtasks list MTIzNDU2Nzg5MA \
    --due-min 2024-04-15T00:00:00Z --due-max 2024-04-22T00:00:00Z

  # include hidden (cleared completed) tasks too
  agentio gtasks list MTIzNDU2Nzg5MA --show-hidden
```

## agentio gtasks get

Get a specific task

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # full task details (notes, due, status, parent)
  agentio gtasks get MTIzNDU2Nzg5MA NjU0MzIxMA
```

## agentio gtasks add

Add a new task

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--title <title>`: Task title
- `--notes <text>`: Task notes/description (or pipe via stdin)
- `--due <date>`: Due date (RFC3339 or YYYY-MM-DD)
- `--parent <task-id>`: Parent task ID (create as subtask)
- `--previous <task-id>`: Previous sibling task ID (controls ordering)

```
Examples:

  # simple task
  agentio gtasks add MTIzNDU2Nzg5MA --title "Buy milk"

  # task with notes (piped from stdin) and a due date
  echo "2 cartons, organic" | agentio gtasks add MTIzNDU2Nzg5MA --title "Buy milk" --due 2024-04-20

  # subtask of an existing task
  agentio gtasks add MTIzNDU2Nzg5MA --title "Section 1" --parent NjU0MzIxMA

  # control ordering: place new task right after another
  agentio gtasks add MTIzNDU2Nzg5MA --title "Step 2" --previous NjU0MzIxMA
```

## agentio gtasks update

Update an existing task

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--title <title>`: New title
- `--notes <text>`: New notes (or pipe via stdin)
- `--due <date>`: New due date (RFC3339 or YYYY-MM-DD, empty to clear)
- `--status <status>`: New status: needsAction or completed

```
Examples:

  # rename a task
  agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --title "Buy oat milk"

  # change due date
  agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --due 2024-04-22

  # replace notes from stdin
  cat new-notes.txt | agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA

  # mark complete via status
  agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --status completed
```

## agentio gtasks done

Mark a task as completed

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # mark a task complete
  agentio gtasks done MTIzNDU2Nzg5MA NjU0MzIxMA
```

## agentio gtasks undo

Mark a task as needs action (not completed)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # revert a task back to needs-action
  agentio gtasks undo MTIzNDU2Nzg5MA NjU0MzIxMA
```

## agentio gtasks delete

Delete a task

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # remove a task entirely (irreversible)
  agentio gtasks delete MTIzNDU2Nzg5MA NjU0MzIxMA
```

## agentio gtasks clear

Clear all completed tasks from a task list

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # hide all completed tasks from the list
  agentio gtasks clear MTIzNDU2Nzg5MA

Cleared tasks remain accessible via 'gtasks list --show-hidden'.
```

## agentio gtasks move

Move a task (change parent or position)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--parent <task-id>`: New parent task ID (make subtask)
- `--previous <task-id>`: Previous sibling task ID (change position)

```
Examples:

  # nest a task under another (make it a subtask)
  agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --parent ABCD1234EFGH

  # reorder: place after a specific sibling
  agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --previous ABCD1234EFGH

  # promote subtask + reorder in one call
  agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --parent NEWP4R3NTID --previous ABCD1234EFGH

At least one of --parent or --previous is required.
```

