---
name: agentio-todo
description: Use when managing a personal tags-only todo list via the agentio CLI (add, list, check, remove).
---

# Todo via agentio

Auto-generated from `agentio skill todo`. Do not edit by hand.

## agentio todo add <title>

Add a todo

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--tag <name>`: Tag (repeatable) (default: )
- `--notes <text>`: Optional notes

```
Examples:

  agentio todo add "Buy milk" --tag errands --json
  agentio todo add "Ship TRD" --tag agentio --tag work
```

## agentio todo list

List todos

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--tag <name>`: Filter by tag
- `--open`: Only open todos (default)
- `--done`: Only done todos
- `--all`: Open and done

```
Examples:

  agentio todo list --tag errands --open --json
  agentio todo list --done
```

## agentio todo get <id>

Get one todo by id

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio todo get tod_abc123 --json
```

## agentio todo check <id>

Mark a todo done

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio todo check tod_abc123
```

## agentio todo uncheck <id>

Reopen a done todo

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio todo uncheck tod_abc123
```

## agentio todo rm <id>

Delete a todo

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--confirm`: Required: deleting cannot be undone

```
Examples:

  agentio todo rm tod_abc123 --confirm
```

## agentio todo tag list

List tags with counts

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio todo tag list --json
```

