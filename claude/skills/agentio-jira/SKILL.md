---
name: agentio-jira
description: Use when interacting with JIRA via the agentio CLI - search issues (paged, JSON), issue history, users, comment, transition.
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

Search JIRA issues (pages through every match up to --limit)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--jql <query>`: JQL query
- `--project <key>`: Project key
- `--status <status>`: Issue status
- `--assignee <name>`: Assignee name
- `--limit <number>`: Maximum number of issues, or "all" (fetched page by page) (default: 50)
- `--page-token <token>`: Continue a truncated search from the token it printed
- `--fields <ids>`: Extra field ids to include, comma-separated (e.g. customfield_10016,duedate); raw values appear under extraFields
- `--json`: Output JSON for programs to read

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

  # backfill: every match since July as JSON (accountIds, created, resolutionDate, parent...)
  agentio jira search --jql "updated >= 2026-07-01 ORDER BY key" --limit all --json > issues.json

  # add custom fields such as story points
  agentio jira search --project PROJ --fields customfield_10016 --json

Results are fetched page by page until --limit is reached. When more issues
match, stderr says so and prints a --page-token to continue from; --json output
carries "truncated" and "nextPageToken". Use a stable ORDER BY for long runs.

JQL syntax: project = KEY, assignee = currentUser(), status = "In Progress",
created >= -7d, updated >= -1d, priority = High, labels = bug, resolution = Unresolved.
Combine with AND / OR / NOT. Quote multi-word values.
```

## agentio jira get <issue-key>

Get JIRA issue details

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--comments`: Include every comment
- `--changelog`: Include the full change history (status changes with dates, for time in status)
- `--fields <ids>`: Extra field ids to include, comma-separated (e.g. customfield_10016,duedate); raw values appear under extraFields
- `--json`: Output JSON for programs to read

```
Examples:

  # summary, status, parent/epic, labels, components, fix versions, dates, description
  agentio jira get PROJ-123

  # with comments and the full status history, as JSON
  agentio jira get PROJ-123 --comments --changelog --json

  # status changes only, for time in status
  agentio jira get PROJ-123 --changelog --json | jq '.changelog[] | {created, items: [.items[] | select(.fieldId == "status")]}'
```

## agentio jira users search <query>

Find users by name or email

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <number>`: Maximum number of users (Jira looks at the first 1000 only) (default: 50)
- `--json`: Output JSON for programs to read

```
Examples:

  # map an email to an accountId
  agentio jira users search alice@example.com --json

  # everyone whose name starts with "ali"
  agentio jira users search ali

Email addresses appear only when the user's profile visibility allows it.
Jira needs the read:jira-user scope for user lookup. Without it the command
says so; assignee and reporter account ids are also in jira search --json.
```

## agentio jira users get <account-id>

Get one user by account id

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio jira users get 5b10a2844c20165700ede21g --json
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

