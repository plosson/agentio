---
name: Todo
slug: todo
auth: Browser sign-in
tagline: Personal tags-only todo list — add, check, filter by tag via the CLI.
icon: ✅
order: 86
---

## What you can do

- Add a todo with one or more tags
- List open, done, or all todos, optionally filtered by tag
- Check off or reopen a todo, get one by id, or delete it
- List tags with counts

## Setup

```sh
agentio todo profile add --url https://todo.example.com
```

The browser opens on the Todo server. Sign in (Google, or dev auth locally), check that the code matches, and approve. Over SSH, add `--no-browser` and open the printed link yourself.

Server: [plosson/todo](https://github.com/plosson/todo).

## Good to know

- Organisation is **tags only** — no projects, boards, or priorities.
- A sign-in lasts as long as it is used. After 90 days without use, run `agentio profile reauth todo`.
- Deleting requires `--confirm`.
