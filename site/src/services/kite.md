---
name: Kite
slug: kite
auth: Browser sign-in
tagline: Publish Markdown and HTML as private web pages, share them, and answer comments.
icon: 🪁
order: 85
---

## What you can do

- Publish a Markdown or HTML file as a private page with a stable link, and publish new versions of it
- Read a document by id or by link, or save it to a file
- Share it with people or a whole domain, make it public, or set when sharing ends
- Read comment threads, comment on a passage, reply, resolve and reopen

## Setup

```sh
agentio kite profile add --url https://kite.example.com
```

The browser opens on the Kite server. Sign in, check that the code matches, and approve. Over SSH, add `--no-browser` and open the printed link yourself.

## Good to know

- Publishing a new version fails if someone changed the document since you read it. Read it again with `agentio kite get` and re-apply your change.
- Commands that change a document take its id (`art_…`). To learn the id of a link, run `agentio kite get <link> --json`.
- A sign-in lasts as long as it is used. After 90 days without use, run `agentio profile reauth kite`.
