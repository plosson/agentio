---
name: Pocket Alert
slug: pocketalert
auth: API Key
tagline: Send push notifications to your phone when an agent needs you.
icon: 🔔
order: 88
---

## What you can do

- Send a push notification with a title and a message
- Send it to one device or all of them, from a given application
- Set its priority, from -2 to 2

## Setup

Copy your API key from Settings in the Pocket Alert app, then:

```sh
agentio pocketalert profile add
```

agentio asks for the key and checks it without sending anything.

## Good to know

- Without `--device`, the message goes to every device on the account.
- Pocket Alert limits how many messages an account can send each day. Past the limit, messages are refused until 00:00 UTC.
