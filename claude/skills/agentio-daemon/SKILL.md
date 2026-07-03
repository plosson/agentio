---
name: agentio-daemon
description: Use to manage the agentio daemon (runs the scheduler for .run.md prompts).
---

# Daemon via agentio

Auto-generated from `agentio skill daemon`. Do not edit by hand.

## agentio daemon install

Install daemon as a system service (launchd on macOS, systemd on Linux)

```
Examples:

  # install and auto-start (macOS LaunchAgent or Linux systemd unit)
  agentio daemon install

  # Linux systemd install needs sudo
  sudo agentio daemon install

  # check it's running afterward
  agentio daemon status
```

## agentio daemon start

Start the daemon

Options:

- `--foreground`: Run in foreground (used by systemd)

```
Examples:

  # start the installed daemon (launchd / systemd) or run in foreground if not installed
  agentio daemon start

  # run in the foreground (used by systemd; useful for dev / debugging)
  agentio daemon start --foreground
```

## agentio daemon stop

Stop the daemon

```
Examples:

  # stop the running daemon
  agentio daemon stop

  # stop, then start fresh (or use `agentio daemon restart`)
  agentio daemon stop && agentio daemon start
```

## agentio daemon restart

Restart the daemon

```
Examples:

  # restart the daemon (e.g. after editing config or installing a new version)
  agentio daemon restart
```

## agentio daemon status

Show daemon status

```
Examples:

  # show whether the daemon is running
  agentio daemon status
```

## agentio daemon logs

View daemon logs

Options:

- `-f, --follow`: Follow log output
- `-n, --lines <n>`: Number of lines to show (default: 50)

```
Examples:

  # last 50 log lines
  agentio daemon logs

  # last 200 log lines
  agentio daemon logs --lines 200

  # tail logs continuously (Ctrl-C to stop)
  agentio daemon logs --follow
```

## agentio daemon uninstall

Remove daemon system service (launchd on macOS, systemd on Linux)

```
Examples:

  # remove the LaunchAgent / systemd unit (config in ~/.config/agentio is preserved)
  agentio daemon uninstall

  # Linux systemd uninstall needs sudo
  sudo agentio daemon uninstall
```
