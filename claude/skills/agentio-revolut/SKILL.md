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

