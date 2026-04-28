---
name: agentio-jira
description: Use when interacting with JIRA via the agentio CLI - search issues, comment, transition.
---

# Jira via agentio

Auto-generated from `agentio skill jira`. Do not edit by hand.

## agentio jira projects

List JIRA projects

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <number>`: Maximum number of projects (default: 50)

```
Examples:

  # all visible projects (default limit 50)
  agentio jira projects

  # cap the result count
  agentio jira projects --limit 10
```

## agentio jira search

Search JIRA issues

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--jql <query>`: JQL query
- `--project <key>`: Project key
- `--status <status>`: Issue status
- `--assignee <name>`: Assignee name
- `--limit <number>`: Maximum number of issues (default: 50)

```
Examples:

  # everything assigned to you across all projects
  agentio jira search --jql "assignee = currentUser() AND resolution = Unresolved"

  # bugs created in the last week in one project
  agentio jira search --jql "project = PROJ AND issuetype = Bug AND created >= -7d"

  # convenience flags (combined with AND)
  agentio jira search --project PROJ --status "In Progress" --assignee alice

  # high-priority items updated today, capped to 10
  agentio jira search --jql "priority = High AND updated >= -1d" --limit 10

JQL syntax: project = KEY, assignee = currentUser(), status = "In Progress",
created >= -7d, updated >= -1d, priority = High, labels = bug, resolution = Unresolved.
Combine with AND / OR / NOT. Quote multi-word values.
```

## agentio jira get <issue-key>

Get JIRA issue details

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # full issue (summary, status, description, comments)
  agentio jira get PROJ-123
```

## agentio jira comment <issue-key> [body]

Add a comment to an issue

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # short comment as an argument
  agentio jira comment PROJ-123 "Reproduced on staging."

  # multi-line comment via stdin
  cat investigation.md | agentio jira comment PROJ-123
```

## agentio jira transitions <issue-key>

List available transitions for an issue

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # see transition ids before calling 'jira transition'
  agentio jira transitions PROJ-123
```

## agentio jira transition <issue-key> <transition-id>

Transition an issue to a new status

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # move PROJ-123 to the status whose transition id is 31
  agentio jira transition PROJ-123 31

  # discover the id first, then run the transition
  agentio jira transitions PROJ-123
  agentio jira transition PROJ-123 41
```

