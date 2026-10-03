---
name: Pocket Pager
slug: pagerio
auth: Pager URL
tagline: Page yourself on your iPhone and Mac when an agent needs you.
icon: 📟
order: 89
---

## What you can do

- Send a page with a message, and optionally a title
- Add a link the notification opens, and longer details in Markdown
- Group related pages, and retry safely with an idempotency key

## Setup

Sign in at [pagerio.chuut.com](https://pagerio.chuut.com) and copy your pager URL with the Copy button. Then:

```sh
agentio pagerio profile add
```

agentio asks for the URL and checks it without paging you.

## Good to know

- The pager URL is the only secret. Anyone who has it can page you, so keep it private.
- The details show only when you open the page, not in the notification.
