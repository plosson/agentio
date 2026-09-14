---
name: Revolut Business
slug: revolut
auth: OAuth + JWT
tagline: Accounts, transactions, expenses and receipts, and payment drafts.
icon: 💶
order: 180
---

## What you can do

- List accounts, balances and transactions, as text, JSON or CSV
- List expenses, and download their receipts into one folder for month-end
- Manage counterparties
- Prepare payments as drafts that a person approves in the Revolut Business app
- Move money between your own accounts, with a confirmation step

agentio cannot send money out of the business by itself. A payment to a counterparty is always a draft, and nothing leaves until someone approves it.

## Setup

Upload an X.509 certificate in the Revolut Business API settings to get a Client ID. Then run:

```sh
agentio revolut profile add --client-id <id> --private-key <path>
```

The private key is stored inside the encrypted vault, so no plaintext copy needs to stay on disk.
