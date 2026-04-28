---
name: agentio-server
description: Use when interacting with server via the agentio CLI.
---

# Server via agentio

Auto-generated from `agentio skill server`. Do not edit by hand.

## agentio server install

Install agentio server as a systemd service

```
Examples:

  # install the agentio HTTP MCP server as a systemd unit (Linux only)
  sudo agentio server install

  # check it's running afterward
  agentio server status
```

## agentio server start

Start the agentio HTTP MCP server

Options:

- `--foreground`: Run in foreground (used by systemd or for dev)
- `--port <n>`: Port to bind (default: 9999)
- `--host <host>`: Host to bind (default: 0.0.0.0)
- `--api-key <key>`: Override the stored API key for this run only

```
Examples:

  # start the installed systemd service (or run in foreground if not installed)
  agentio server start

  # run the server directly in the foreground (used by systemd; useful for dev)
  agentio server start --foreground

  # foreground on a specific port and host
  agentio server start --foreground --port 8080 --host 127.0.0.1

  # one-shot run with an override API key (does not persist)
  agentio server start --foreground --api-key srv_xxx
```

## agentio server stop

Stop the agentio server (systemd only)

```
Examples:

  # stop the systemd-managed agentio server
  sudo agentio server stop
```

## agentio server restart

Restart the agentio server (systemd only)

```
Examples:

  # restart the systemd-managed agentio server (e.g. after editing config)
  sudo agentio server restart
```

## agentio server status

Show agentio server status

```
Examples:

  # show whether the server is running and the (truncated) API key
  agentio server status
```

## agentio server logs

View agentio server logs (systemd / journalctl)

Options:

- `-f, --follow`: Follow log output
- `-n, --lines <n>`: Number of lines to show (default: 50)

```
Examples:

  # last 50 log lines (systemd / journalctl)
  agentio server logs

  # last 200 log lines
  agentio server logs --lines 200

  # follow logs continuously (Ctrl-C to stop)
  agentio server logs --follow
```

## agentio server tokens list

List all issued bearer tokens

```
Examples:

  # list every issued bearer (shows id prefix, client, scope, issued/expires)
  agentio server tokens list
```

## agentio server tokens revoke <id>

Revoke a token by its 12-character prefix or full opaque value

```
Examples:

  # revoke by 12-char prefix (from `tokens list`)
  agentio server tokens revoke abc123def456

  # revoke by full opaque token value
  agentio server tokens revoke <full-token>
```

## agentio server tokens clear

Revoke ALL issued tokens (forces every client to re-auth)

```
Examples:

  # revoke every issued bearer (every client must re-authorize)
  agentio server tokens clear
```

## agentio server uninstall

Remove agentio-server systemd service

```
Examples:

  # remove the systemd unit (config in ~/.config/agentio is preserved)
  sudo agentio server uninstall
```
