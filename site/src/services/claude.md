---
name: Claude
slug: claude
auth: Subscription token or API key
tagline: Ask Claude a question from a script or another agent, and get the answer back.
icon: 🧠
order: 30
---

## What you can do

- Ask Claude a question and print the answer
- Pipe input in, such as a diff or a log, and add it after your prompt
- Choose the model, a system prompt and the reasoning effort
- Print the answer as JSON, with the model, usage, cost and duration

## Setup

```sh
agentio claude profile add
```

agentio offers to run `claude setup-token`, then asks for the token it shows. You can also paste an API key.

## Good to know

- The `claude` CLI must be installed on the machine where the command runs.
- A question runs as a plain question: no tools, no files, no project settings.
- With a subscription token, Claude Code adds your account email as context for the model.
- A token made by `claude setup-token` lasts a year.
