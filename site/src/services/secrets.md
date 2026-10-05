---
name: Secrets
slug: secrets
auth: None
tagline: Keep passwords and API keys in the vault, and hand them to scripts without showing them to the agent.
icon: 🔑
order: 95
---

## What you can do

- Store secrets by name, grouped in profiles such as `smtp` or `stripe`
- Read one value, or list the names
- Load a `.env` file into a profile
- Run a command with a profile's secrets as environment variables

## Setup

```sh
agentio secrets profile add --profile smtp
agentio secrets set SMTP_PASSWORD --profile smtp
```

agentio asks for the value without showing it.

## Good to know

- Names must be valid environment variable names: letters, digits and `_`, not starting with a digit.
- `list` shows only names. Add `--reveal` to see values.
- `exec` keeps values out of the agent's context, but the command it runs can still print them.
