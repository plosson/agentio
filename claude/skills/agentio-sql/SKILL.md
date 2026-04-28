---
name: agentio-sql
description: Use when running SQL queries via the agentio CLI.
---

# Sql via agentio

Auto-generated from `agentio skill sql`. Do not edit by hand.

## agentio sql query [query]

Execute a SQL query

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Maximum rows to return (default: 100)

```
Examples:

  # one-shot SELECT against the default profile
  agentio sql query "SELECT id, email FROM users LIMIT 10"

  # cap rows for an exploratory query
  agentio sql query "SELECT * FROM events" --limit 25

  # pipe a multi-line query via stdin
  cat report.sql | agentio sql query

  # run against a specific profile
  agentio sql query --profile prod "SELECT count(*) FROM orders"
```
