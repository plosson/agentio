---
name: Falco
slug: falco
auth: Password + 2FA
tagline: Inbound Peppol documents and outbound billing documents.
icon: '<img src="/falco-icon.png" alt="">'
order: 190
---

## What you can do

- List inbound Peppol documents, filtered by date, sender or import state
- Download one document's UBL XML, or sync every matching document into a directory
- Import a Peppol inbox document into the purchase-invoice register
- Set the payment status of a purchase invoice
- Sync outbound billing document PDFs — invoices, credit notes, estimates, proformas

One profile is one Falco login scoped to one organization. An account holding several organizations needs one profile per organization.

## Setup

```sh
agentio falco profile add
```

The login asks for your password, and for a 2FA code when Falco wants one. Only the refresh token is kept, inside the encrypted vault.

A profile added with `--read-only` cannot change payment status:

```sh
agentio falco profile add --profile audit --read-only
```
