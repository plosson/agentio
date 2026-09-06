---
name: agentio-revolut
description: Use when interacting with revolut via the agentio CLI.
---

# Revolut via agentio

Auto-generated from `agentio skill revolut`. Do not edit by hand.

## agentio revolut accounts

List accounts and balances

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # all accounts with balances
  agentio revolut accounts

  # machine-readable balances
  agentio revolut accounts --format json
```

## agentio revolut transactions

List transactions

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--from <date>`: Start date (YYYY-MM-DD)
- `--to <date>`: End date (YYYY-MM-DD)
- `--account <id>`: Filter by account ID
- `--counterparty <id>`: Filter by counterparty ID
- `--type <type>`: Filter by type (e.g. card_payment, transfer, exchange)
- `--count <number>`: Maximum transactions to return (max 1000) (default: 100)
- `--format <format>`: Output format: text, json, or csv (default: text)

```
Examples:

  # most recent transactions
  agentio revolut transactions

  # a date range, one leg per CSV row
  agentio revolut transactions --from 2026-04-01 --to 2026-06-30 --format csv

  # card payments only, on one account
  agentio revolut transactions --type card_payment --account 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a
```

## agentio revolut transaction <id>

Get one transaction with its legs

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # full detail for one transaction
  agentio revolut transaction 6b8e1f30-1c2d-4a5b-8e9f-0a1b2c3d4e5f
```

## agentio revolut pay

Draft a payment to a counterparty, or move money between your own accounts

Options:

- `--from <account-id>`: Your account to pay from
- `--to <id>`: Counterparty ID, or one of your own account IDs to move money internally
- `--amount <number>`: Amount to send
- `--currency <code>`: Currency, ISO 4217 (e.g. EUR)
- `--reference <text>`: Reference shown to you and the recipient (required for a counterparty)
- `--to-account <id>`: Counterparty's receiving account (when it has more than one)
- `--to-card <id>`: Counterparty's card, for a card transfer
- `--title <text>`: Title for the draft
- `--on <date>`: Schedule the draft for a date, YYYY-MM-DD
- `--charge-bearer <who>`: Who pays the route fees: shared (SHA) or debtor (OUR)
- `--reason-code <code>`: Transfer reason code, required by some corridors
- `--request-id <id>`: Idempotency key for an own-account move (a UUID is generated when omitted)
- `--force`: Skip the confirmation prompt on an own-account move
- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # draft a payment - nothing moves until it is approved in the Revolut Business app
  agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \
    --to 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f \
    --amount 250 --currency EUR --reference "Invoice 42"

  # draft it for the 1st of next month
  agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \
    --to 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f \
    --amount 1200 --currency EUR --reference "Rent" --title "October rent" --on 2026-10-01

  # move money between two of your own accounts (detected from --to, executes now)
  agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \
    --to 1b2c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e --amount 500 --currency EUR

  # then review and discard what was drafted
  agentio revolut drafts list
  agentio revolut drafts delete <draft-id>
```

## agentio revolut counterparties list

List counterparties

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # every saved payee with its account numbers
  agentio revolut counterparties list
```

## agentio revolut counterparties get <id>

Get one counterparty

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # full bank details for one payee
  agentio revolut counterparties get 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f
```

## agentio revolut counterparties add

Add a counterparty

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--company-name <name>`: Company name (use instead of --first-name/--last-name)
- `--first-name <name>`: Individual first name
- `--last-name <name>`: Individual last name
- `--bank-country <code>`: Bank country, ISO 3166-1 alpha-2 (e.g. BE)
- `--currency <code>`: Account currency (e.g. EUR)
- `--iban <iban>`: IBAN
- `--bic <bic>`: BIC/SWIFT
- `--account-no <number>`: Account number (non-IBAN)
- `--sort-code <code>`: Sort code (UK)
- `--routing-number <number>`: Routing number (US)
- `--email <email>`: Contact email
- `--phone <phone>`: Contact phone

```
Examples:

  # a Belgian company payee
  agentio revolut counterparties add --company-name "Acme Supplies BV" \
    --bank-country BE --currency EUR --iban BE68539007547034

  # an individual payee
  agentio revolut counterparties add --first-name Jane --last-name Doe \
    --bank-country BE --currency EUR --iban BE68539007547034
```

## agentio revolut counterparties delete <id>

Delete a counterparty

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--force`: Skip the confirmation prompt

```
Examples:

  # delete with a confirmation prompt
  agentio revolut counterparties delete 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f

  # delete without prompting
  agentio revolut counterparties delete 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f --force
```

## agentio revolut drafts list

List payment drafts awaiting approval

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--source <source>`: Filter by origin: api, integration, email, or all (default: api)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # drafts created through the API
  agentio revolut drafts list

  # every draft, including ones raised in the Revolut Business app
  agentio revolut drafts list --source all
```

## agentio revolut drafts get <id>

Get one payment draft with its payments

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # full detail for one draft
  agentio revolut drafts get e7e54cb2-861a-4a1f-80e9-3e6600f3db10
```

## agentio revolut drafts delete <id>

Delete a payment draft that has not been sent for processing

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--force`: Skip the confirmation prompt

```
Examples:

  # delete with a confirmation prompt
  agentio revolut drafts delete e7e54cb2-861a-4a1f-80e9-3e6600f3db10

  # delete without prompting
  agentio revolut drafts delete e7e54cb2-861a-4a1f-80e9-3e6600f3db10 --force
```

## agentio revolut links list

List payout links

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--created-before <timestamp>`: Only links created before this ISO 8601 timestamp
- `--limit <number>`: Maximum links to return (max 1000) (default: 100)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # most recent payout links
  agentio revolut links list

  # the next page, using the created_at of the last link on this one
  agentio revolut links list --created-before 2026-07-11T13:55:54.834963Z
```

## agentio revolut links get <id>

Get one payout link

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Output format: text or json (default: text)

```
Examples:

  # check whether a link has been claimed
  agentio revolut links get 12dcd8c2-6408-458f-98a9-3f4abc180898
```

## agentio revolut links cancel <id>

Cancel a payout link that has not been claimed

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--force`: Skip the confirmation prompt

```
Examples:

  # cancel with a confirmation prompt
  agentio revolut links cancel 12dcd8c2-6408-458f-98a9-3f4abc180898

  # cancel without prompting
  agentio revolut links cancel 12dcd8c2-6408-458f-98a9-3f4abc180898 --force
```

