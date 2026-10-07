---
name: ChatGPT
slug: chatgpt
auth: Browser sign-in or API key
tagline: Ask ChatGPT a question from a script or another agent, and get the answer back.
icon: 💬
order: 35
---

## What you can do

- Ask ChatGPT a question and print the answer
- Pipe input in, such as a diff or a log, and add it after your prompt
- Choose the model, a system prompt and the reasoning effort
- Print the answer as JSON, with the model, usage and duration

## Setup

```sh
agentio chatgpt profile add
```

The browser opens so you can sign in with your ChatGPT account. This is agentio's own sign-in, separate from `codex login`. To use an OpenAI API key instead, add `--api-key`.

## Good to know

- The `codex` CLI must be installed on the machine where the command runs.
- A question runs as a plain question: no tools, no files, no project settings.
- `codex` only ever gets a short-lived access token. The agentio daemon refreshes it.
- If the sign-in stops working, run `agentio profile reauth chatgpt`.
