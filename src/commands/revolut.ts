import { Command } from 'commander';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { createPrivateKey, randomUUID } from 'crypto';
import { setCredentials, getCredentials } from '../auth/token-store';
import { setProfile, resolveProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import {
  buildConsentUrl,
  exchangeCodeForTokens,
  extractAuthorizationCode,
  issuerFromRedirectUri,
  refreshRevolutToken,
} from '../auth/revolut-oauth';
import { launchBrowser } from '../auth/oauth-server';
import { RevolutClient } from '../services/revolut/client';
import { CliError, handleError, multipleProfilesError } from '../utils/errors';
import { prompt, confirm } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import {
  printRevolutAccountList,
  printRevolutTransactionList,
  printRevolutTransaction,
  printRevolutTransactionsCsv,
  printRevolutCounterpartyList,
  printRevolutCounterparty,
  printRevolutCounterpartyDeleted,
  printRevolutTransferResult,
  printRevolutPaymentDraftCreated,
  printRevolutPaymentDraftList,
  printRevolutPaymentDraft,
  printRevolutPaymentDraftDeleted,
  printRevolutPayoutLink,
  printRevolutPayoutLinkList,
  printRevolutPayoutLinkCancelled,
} from '../utils/output';
import type {
  RevolutAccount,
  RevolutChargeBearer,
  RevolutCredentials,
  RevolutEnvironment,
} from '../types/revolut';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Revolut access tokens live 40 minutes, so most invocations refresh first.
 * The refresh token is not rotated, only the access token is replaced.
 */
async function ensureValidToken(credentials: RevolutCredentials, profile: string): Promise<RevolutCredentials> {
  if (credentials.expiryDate && Date.now() + TOKEN_EXPIRY_BUFFER_MS < credentials.expiryDate) {
    return credentials;
  }

  try {
    const refreshed = await refreshRevolutToken(credentials);
    const newCredentials: RevolutCredentials = {
      ...credentials,
      accessToken: refreshed.accessToken,
      expiryDate: Date.now() + refreshed.expiresIn * 1000,
    };
    await setCredentials('revolut', profile, newCredentials);
    return newCredentials;
  } catch (error) {
    const detail = error instanceof CliError ? ` (${error.message})` : '';
    throw new CliError(
      'AUTH_FAILED',
      `Failed to refresh the Revolut access token${detail}`,
      `Run: agentio revolut profile add --profile ${profile}`,
    );
  }
}

async function getRevolutClient(profileName?: string): Promise<{ client: RevolutClient; profile: string }> {
  const profileResult = await resolveProfile('revolut', profileName);

  if (profileResult.profile === null) {
    if (profileResult.error === 'none') {
      if (profileName) {
        throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found for revolut`, 'Run: agentio revolut profile add');
      }
      throw new CliError('PROFILE_NOT_FOUND', 'No revolut profile configured', 'Run: agentio revolut profile add');
    }
    throw multipleProfilesError('revolut', profileResult.names);
  }

  const profile = profileResult.profile;
  const stored = await getCredentials<RevolutCredentials>('revolut', profile);

  if (!stored) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for revolut profile "${profile}"`,
      `Run: agentio revolut profile add --profile ${profile}`,
    );
  }

  const credentials = await ensureValidToken(stored, profile);
  return { client: new RevolutClient(credentials), profile };
}

function expandPath(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return `${homedir()}/${filePath.slice(2)}`;
  return filePath;
}

function readPrivateKey(filePath: string): string {
  let pem: string;
  try {
    pem = readFileSync(expandPath(filePath), 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new CliError('INVALID_PARAMS', `Could not read the private key: ${message}`);
  }

  try {
    createPrivateKey(pem);
  } catch {
    throw new CliError(
      'INVALID_PARAMS',
      `The file "${filePath}" is not a valid PEM private key`,
      'Point --private-key at the key you generated alongside the certificate uploaded to Revolut',
    );
  }

  return pem;
}

function parseAmount(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CliError('INVALID_PARAMS', `--amount must be a positive number, got "${value}"`);
  }
  return amount;
}

function parseChargeBearer(value: string): RevolutChargeBearer {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'shared' || normalized === 'debtor') return normalized;
  throw new CliError(
    'INVALID_PARAMS',
    `Unknown charge bearer "${value}"`,
    'Use shared (SHA, fees split) or debtor (OUR, you pay all fees)',
  );
}

function describeAccount(account: RevolutAccount): string {
  return account.name ? `"${account.name}"` : account.id;
}

function formatMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

function parseEnvironment(value: string): RevolutEnvironment {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod') return 'production';
  if (normalized === 'sandbox') return 'sandbox';
  throw new CliError('INVALID_PARAMS', `Unknown environment "${value}"`, 'Use production or sandbox');
}

interface PayOptions {
  profile?: string;
  from: string;
  to: string;
  toAccount?: string;
  toCard?: string;
  amount: string;
  currency: string;
  reference?: string;
  chargeBearer?: string;
  reasonCode?: string;
  requestId?: string;
  title?: string;
  on?: string;
  force?: boolean;
  format: string;
}

/**
 * Paying a counterparty always produces a payment draft, never a transfer.
 * Nothing leaves the business until a human approves the draft in the Revolut
 * Business app, so a mistake here is recoverable with `drafts delete`. The one
 * destination that acts immediately is another of your own accounts, where the
 * money never leaves the business at all.
 */
async function runPay(options: PayOptions): Promise<void> {
  if (options.on && !/^\d{4}-\d{2}-\d{2}$/.test(options.on)) {
    throw new CliError('INVALID_PARAMS', `--on must be a date as YYYY-MM-DD, got "${options.on}"`);
  }

  const amount = parseAmount(options.amount);
  const currency = options.currency.trim().toUpperCase();
  const chargeBearer = options.chargeBearer ? parseChargeBearer(options.chargeBearer) : undefined;
  const asJson = options.format === 'json';

  const { client, profile } = await getRevolutClient(options.profile);
  await enforceWriteAccess('revolut', profile, 'move money');

  const accounts = await client.listAccounts();
  const source = accounts.find((account) => account.id === options.from);
  if (!source) {
    throw new CliError(
      'NOT_FOUND',
      `--from "${options.from}" is not one of your accounts`,
      'Run: agentio revolut accounts',
    );
  }

  const target = accounts.find((account) => account.id === options.to);

  if (target) {
    if (options.toAccount || options.toCard) {
      throw new CliError('INVALID_PARAMS', '--to-account and --to-card only apply to counterparty payments');
    }
    if (chargeBearer || options.reasonCode) {
      throw new CliError('INVALID_PARAMS', '--charge-bearer and --reason-code only apply to counterparty payments');
    }
    if (options.on || options.title) {
      throw new CliError(
        'INVALID_PARAMS',
        '--on and --title only apply to counterparty payments',
        `"${options.to}" is your own account, so the money moves immediately and there is no draft to schedule or name`,
      );
    }
    if (source.currency !== currency || target.currency !== currency) {
      throw new CliError(
        'INVALID_PARAMS',
        `Moving money between your own accounts needs a single currency: ${describeAccount(source)} holds ${source.currency}, ${describeAccount(target)} holds ${target.currency}, and --currency is ${currency}`,
        'Exchange the funds in the Revolut Business app first',
      );
    }

    // Revolut de-duplicates repeats of a request ID for two weeks, so a retry
    // after a network error cannot move the money twice.
    const requestId = options.requestId?.trim() || randomUUID();
    const summary = `Move ${formatMoney(amount, currency)} from ${describeAccount(source)} to ${describeAccount(target)} (your own account)`;

    // The only path that acts straight away, so it is the only one that asks.
    if (!options.force) {
      const confirmed = await confirm(`${summary}?`);
      if (!confirmed) {
        console.error('Cancelled');
        return;
      }
    }

    const result = await client.createTransfer({
      requestId,
      sourceAccountId: source.id,
      targetAccountId: target.id,
      amount,
      currency,
      reference: options.reference,
    });

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printRevolutTransferResult(result, summary);
    }
    return;
  }

  if (!options.reference) {
    throw new CliError('INVALID_PARAMS', 'A payment draft requires --reference');
  }

  // Resolve the payee up front so the summary names it and a wrong ID fails
  // before the draft is written.
  const counterparty = await client.getCounterparty(options.to);

  const id = await client.createPaymentDraft({
    title: options.title,
    scheduleFor: options.on,
    accountId: source.id,
    counterpartyId: counterparty.id,
    counterpartyAccountId: options.toAccount,
    counterpartyCardId: options.toCard,
    amount,
    currency,
    reference: options.reference,
    chargeBearer,
    transferReasonCode: options.reasonCode,
  });

  if (asJson) {
    console.log(JSON.stringify({ id }, null, 2));
    return;
  }

  const when = options.on ? `, scheduled for ${options.on}` : '';
  printRevolutPaymentDraftCreated(
    id,
    `Drafted ${formatMoney(amount, currency)} to ${counterparty.name}${when}, from ${describeAccount(source)}`,
  );
}

export function registerRevolutCommands(program: Command): void {
  const revolut = program.command('revolut').description('Revolut Business operations');

  addExamples(
    revolut
      .command('accounts')
      .description('List accounts and balances')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (options) => {
        try {
          const { client } = await getRevolutClient(options.profile);
          const accounts = await client.listAccounts();

          if (options.format === 'json') {
            console.log(JSON.stringify(accounts, null, 2));
          } else {
            printRevolutAccountList(accounts);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # all accounts with balances
  agentio revolut accounts

  # machine-readable balances
  agentio revolut accounts --format json`,
  );

  addExamples(
    revolut
      .command('transactions')
      .description('List transactions')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--from <date>', 'Start date (YYYY-MM-DD)')
      .option('--to <date>', 'End date (YYYY-MM-DD)')
      .option('--account <id>', 'Filter by account ID')
      .option('--counterparty <id>', 'Filter by counterparty ID')
      .option('--type <type>', 'Filter by type (e.g. card_payment, transfer, exchange)')
      .option('--count <number>', 'Maximum transactions to return (max 1000)', '100')
      .option('--format <format>', 'Output format: text, json, or csv', 'text')
      .action(async (options) => {
        try {
          const count = parseInt(options.count, 10);
          if (isNaN(count) || count < 1) {
            throw new CliError('INVALID_PARAMS', '--count must be a positive number');
          }

          const { client } = await getRevolutClient(options.profile);
          const transactions = await client.listTransactions({
            from: options.from,
            to: options.to,
            accountId: options.account,
            counterpartyId: options.counterparty,
            type: options.type,
            count,
          });

          if (options.format === 'json') {
            console.log(JSON.stringify(transactions, null, 2));
          } else if (options.format === 'csv') {
            printRevolutTransactionsCsv(transactions);
          } else {
            printRevolutTransactionList(transactions);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # most recent transactions
  agentio revolut transactions

  # a date range, one leg per CSV row
  agentio revolut transactions --from 2026-04-01 --to 2026-06-30 --format csv

  # card payments only, on one account
  agentio revolut transactions --type card_payment --account 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a`,
  );

  addExamples(
    revolut
      .command('transaction')
      .description('Get one transaction with its legs')
      .argument('<id>', 'Transaction ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (id: string, options) => {
        try {
          const { client } = await getRevolutClient(options.profile);
          const transaction = await client.getTransaction(id);

          if (options.format === 'json') {
            console.log(JSON.stringify(transaction, null, 2));
          } else {
            printRevolutTransaction(transaction);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # full detail for one transaction
  agentio revolut transaction 6b8e1f30-1c2d-4a5b-8e9f-0a1b2c3d4e5f`,
  );

  addExamples(
    revolut
      .command('pay')
      .description('Draft a payment to a counterparty, or move money between your own accounts')
      .requiredOption('--from <account-id>', 'Your account to pay from')
      .requiredOption('--to <id>', 'Counterparty ID, or one of your own account IDs to move money internally')
      .requiredOption('--amount <number>', 'Amount to send')
      .requiredOption('--currency <code>', 'Currency, ISO 4217 (e.g. EUR)')
      .option('--reference <text>', 'Reference shown to you and the recipient (required for a counterparty)')
      .option('--to-account <id>', "Counterparty's receiving account (when it has more than one)")
      .option('--to-card <id>', "Counterparty's card, for a card transfer")
      .option('--title <text>', 'Title for the draft')
      .option('--on <date>', 'Schedule the draft for a date, YYYY-MM-DD')
      .option('--charge-bearer <who>', 'Who pays the route fees: shared (SHA) or debtor (OUR)')
      .option('--reason-code <code>', 'Transfer reason code, required by some corridors')
      .option('--request-id <id>', 'Idempotency key for an own-account move (a UUID is generated when omitted)')
      .option('--force', 'Skip the confirmation prompt on an own-account move')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (options: PayOptions) => {
        try {
          await runPay(options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # draft a payment - nothing moves until it is approved in the Revolut Business app
  agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \\
    --to 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f \\
    --amount 250 --currency EUR --reference "Invoice 42"

  # draft it for the 1st of next month
  agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \\
    --to 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f \\
    --amount 1200 --currency EUR --reference "Rent" --title "October rent" --on 2026-10-01

  # move money between two of your own accounts (detected from --to, executes now)
  agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \\
    --to 1b2c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e --amount 500 --currency EUR

  # then review and discard what was drafted
  agentio revolut drafts list
  agentio revolut drafts delete <draft-id>`,
  );

  const counterparties = revolut
    .command('counterparties')
    .description('Manage counterparties (payees)');

  addExamples(
    counterparties
      .command('list')
      .description('List counterparties')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (options) => {
        try {
          const { client } = await getRevolutClient(options.profile);
          const results = await client.listCounterparties();

          if (options.format === 'json') {
            console.log(JSON.stringify(results, null, 2));
          } else {
            printRevolutCounterpartyList(results);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # every saved payee with its account numbers
  agentio revolut counterparties list`,
  );

  addExamples(
    counterparties
      .command('get')
      .description('Get one counterparty')
      .argument('<id>', 'Counterparty ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (id: string, options) => {
        try {
          const { client } = await getRevolutClient(options.profile);
          const counterparty = await client.getCounterparty(id);

          if (options.format === 'json') {
            console.log(JSON.stringify(counterparty, null, 2));
          } else {
            printRevolutCounterparty(counterparty);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # full bank details for one payee
  agentio revolut counterparties get 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f`,
  );

  addExamples(
    counterparties
      .command('add')
      .description('Add a counterparty')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--company-name <name>', 'Company name (use instead of --first-name/--last-name)')
      .option('--first-name <name>', 'Individual first name')
      .option('--last-name <name>', 'Individual last name')
      .requiredOption('--bank-country <code>', 'Bank country, ISO 3166-1 alpha-2 (e.g. BE)')
      .requiredOption('--currency <code>', 'Account currency (e.g. EUR)')
      .option('--iban <iban>', 'IBAN')
      .option('--bic <bic>', 'BIC/SWIFT')
      .option('--account-no <number>', 'Account number (non-IBAN)')
      .option('--sort-code <code>', 'Sort code (UK)')
      .option('--routing-number <number>', 'Routing number (US)')
      .option('--email <email>', 'Contact email')
      .option('--phone <phone>', 'Contact phone')
      .action(async (options) => {
        try {
          if (!options.companyName && !(options.firstName && options.lastName)) {
            throw new CliError(
              'INVALID_PARAMS',
              'A counterparty needs a name',
              'Pass --company-name, or both --first-name and --last-name',
            );
          }

          if (!options.iban && !options.accountNo) {
            throw new CliError('INVALID_PARAMS', 'Pass --iban or --account-no');
          }

          const { client, profile } = await getRevolutClient(options.profile);
          await enforceWriteAccess('revolut', profile, 'add a counterparty');

          const counterparty = await client.createCounterparty({
            companyName: options.companyName,
            individualFirstName: options.firstName,
            individualLastName: options.lastName,
            bankCountry: options.bankCountry,
            currency: options.currency,
            iban: options.iban,
            bic: options.bic,
            accountNo: options.accountNo,
            sortCode: options.sortCode,
            routingNumber: options.routingNumber,
            email: options.email,
            phone: options.phone,
          });

          printRevolutCounterparty(counterparty);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # a Belgian company payee
  agentio revolut counterparties add --company-name "Acme Supplies BV" \\
    --bank-country BE --currency EUR --iban BE68539007547034

  # an individual payee
  agentio revolut counterparties add --first-name Jane --last-name Doe \\
    --bank-country BE --currency EUR --iban BE68539007547034`,
  );

  addExamples(
    counterparties
      .command('delete')
      .description('Delete a counterparty')
      .argument('<id>', 'Counterparty ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--force', 'Skip the confirmation prompt')
      .action(async (id: string, options) => {
        try {
          const { client, profile } = await getRevolutClient(options.profile);
          await enforceWriteAccess('revolut', profile, 'delete a counterparty');

          if (!options.force) {
            const counterparty = await client.getCounterparty(id);
            const confirmed = await confirm(`Delete counterparty "${counterparty.name}" (${id})?`);
            if (!confirmed) {
              console.error('Cancelled');
              return;
            }
          }

          await client.deleteCounterparty(id);
          printRevolutCounterpartyDeleted(id);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # delete with a confirmation prompt
  agentio revolut counterparties delete 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f

  # delete without prompting
  agentio revolut counterparties delete 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f --force`,
  );

  const drafts = revolut.command('drafts').description('Manage the payment drafts that pay creates');

  addExamples(
    drafts
      .command('list')
      .description('List payment drafts awaiting approval')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--source <source>', 'Filter by origin: api, integration, email, or all', 'api')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (options) => {
        try {
          const { client } = await getRevolutClient(options.profile);
          const results = await client.listPaymentDrafts(options.source);

          if (options.format === 'json') {
            console.log(JSON.stringify(results, null, 2));
          } else {
            printRevolutPaymentDraftList(results);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # drafts created through the API
  agentio revolut drafts list

  # every draft, including ones raised in the Revolut Business app
  agentio revolut drafts list --source all`,
  );

  addExamples(
    drafts
      .command('get')
      .description('Get one payment draft with its payments')
      .argument('<id>', 'Payment draft ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (id: string, options) => {
        try {
          const { client } = await getRevolutClient(options.profile);
          const draft = await client.getPaymentDraft(id);

          if (options.format === 'json') {
            console.log(JSON.stringify(draft, null, 2));
          } else {
            printRevolutPaymentDraft(id, draft);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # full detail for one draft
  agentio revolut drafts get e7e54cb2-861a-4a1f-80e9-3e6600f3db10`,
  );

  addExamples(
    drafts
      .command('delete')
      .description('Delete a payment draft that has not been sent for processing')
      .argument('<id>', 'Payment draft ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--force', 'Skip the confirmation prompt')
      .action(async (id: string, options) => {
        try {
          const { client, profile } = await getRevolutClient(options.profile);
          await enforceWriteAccess('revolut', profile, 'delete a payment draft');

          if (!options.force) {
            const draft = await client.getPaymentDraft(id);
            const title = draft.title ? `"${draft.title}"` : id;
            const confirmed = await confirm(`Delete payment draft ${title} (${draft.payments.length} payment(s))?`);
            if (!confirmed) {
              console.error('Cancelled');
              return;
            }
          }

          await client.deletePaymentDraft(id);
          printRevolutPaymentDraftDeleted(id);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # delete with a confirmation prompt
  agentio revolut drafts delete e7e54cb2-861a-4a1f-80e9-3e6600f3db10

  # delete without prompting
  agentio revolut drafts delete e7e54cb2-861a-4a1f-80e9-3e6600f3db10 --force`,
  );

  const links = revolut.command('links').description('Inspect and cancel payout links raised in the Revolut Business app');

  addExamples(
    links
      .command('list')
      .description('List payout links')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--created-before <timestamp>', 'Only links created before this ISO 8601 timestamp')
      .option('--limit <number>', 'Maximum links to return (max 1000)', '100')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (options) => {
        try {
          const limit = parseInt(options.limit, 10);
          if (isNaN(limit) || limit < 1) {
            throw new CliError('INVALID_PARAMS', '--limit must be a positive number');
          }

          const { client } = await getRevolutClient(options.profile);
          const results = await client.listPayoutLinks({ createdBefore: options.createdBefore, limit });

          if (options.format === 'json') {
            console.log(JSON.stringify(results, null, 2));
          } else {
            printRevolutPayoutLinkList(results);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # most recent payout links
  agentio revolut links list

  # the next page, using the created_at of the last link on this one
  agentio revolut links list --created-before 2026-07-11T13:55:54.834963Z`,
  );

  addExamples(
    links
      .command('get')
      .description('Get one payout link')
      .argument('<id>', 'Payout link ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (id: string, options) => {
        try {
          const { client } = await getRevolutClient(options.profile);
          const link = await client.getPayoutLink(id);

          if (options.format === 'json') {
            console.log(JSON.stringify(link, null, 2));
          } else {
            printRevolutPayoutLink(link);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # check whether a link has been claimed
  agentio revolut links get 12dcd8c2-6408-458f-98a9-3f4abc180898`,
  );

  addExamples(
    links
      .command('cancel')
      .description('Cancel a payout link that has not been claimed')
      .argument('<id>', 'Payout link ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--force', 'Skip the confirmation prompt')
      .action(async (id: string, options) => {
        try {
          const { client, profile } = await getRevolutClient(options.profile);
          await enforceWriteAccess('revolut', profile, 'cancel a payout link');

          if (!options.force) {
            const link = await client.getPayoutLink(id);
            const confirmed = await confirm(
              `Cancel the ${formatMoney(link.amount, link.currency)} payout link to ${link.counterpartyName}?`,
            );
            if (!confirmed) {
              console.error('Cancelled');
              return;
            }
          }

          await client.cancelPayoutLink(id);
          printRevolutPayoutLinkCancelled(id);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # cancel with a confirmation prompt
  agentio revolut links cancel 12dcd8c2-6408-458f-98a9-3f4abc180898

  # cancel without prompting
  agentio revolut links cancel 12dcd8c2-6408-458f-98a9-3f4abc180898 --force`,
  );

  const profile = createProfileCommands<RevolutCredentials>(revolut, {
    service: 'revolut',
    displayName: 'Revolut',
    getExtraInfo: (credentials) => (credentials ? ` - ${credentials.environment}` : ''),
  });

  profile
    .command('add')
    .description('Add a new Revolut profile')
    .option('--profile <name>', 'Profile name (defaults to the environment)')
    .option('--environment <env>', 'production or sandbox')
    .option('--client-id <id>', 'Client ID issued by Revolut')
    .option('--private-key <path>', 'Path to the PEM private key matching your uploaded certificate')
    .option('--redirect-uri <uri>', 'OAuth redirect URI registered with Revolut')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await revolutProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export interface RevolutProfileAddOptions {
  profile?: string;
  environment?: string;
  clientId?: string;
  privateKey?: string;
  redirectUri?: string;
  readOnly?: boolean;
}

export async function revolutProfileAdd(options: RevolutProfileAddOptions): Promise<void> {
  console.error('\nRevolut Business Setup\n');
  console.error('Prerequisite: in the Revolut Business app, go to Settings > APIs > Business API,');
  console.error('upload your X.509 public certificate, and register an OAuth redirect URI.\n');

  const environment = parseEnvironment(
    options.environment || (await prompt('? Environment (production/sandbox) [production]: ')) || 'production',
  );

  const clientId = (options.clientId || (await prompt('? Client ID: '))).trim();
  if (!clientId) {
    throw new CliError('INVALID_PARAMS', 'Client ID is required');
  }

  const keyPath = options.privateKey || (await prompt('? Path to private key (PEM): '));
  if (!keyPath) {
    throw new CliError('INVALID_PARAMS', 'Private key path is required');
  }
  const privateKey = readPrivateKey(keyPath);

  const redirectUri = (options.redirectUri || (await prompt('? OAuth redirect URI: '))).trim();
  if (!redirectUri) {
    throw new CliError('INVALID_PARAMS', 'Redirect URI is required');
  }
  issuerFromRedirectUri(redirectUri); // validates the URI up front

  const consentUrl = buildConsentUrl({ environment, clientId, redirectUri });

  console.error('\nAuthorise the app in your browser:');
  console.error(`  ${consentUrl}\n`);
  console.error(`After approving, the browser is redirected to ${redirectUri} with a "code" parameter.`);
  console.error('That page does not need to load - copy the address bar contents.\n');
  console.error('The code expires about two minutes after it is issued.\n');
  launchBrowser(consentUrl);

  const pasted = await prompt('? Paste the redirect URL (or just the code): ');
  const code = extractAuthorizationCode(pasted);

  console.error('\nExchanging the authorisation code...');
  const tokens = await exchangeCodeForTokens(code, { clientId, privateKey, redirectUri, environment });

  const credentials: RevolutCredentials = {
    environment,
    clientId,
    privateKey,
    redirectUri,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
  };

  console.error('Validating access...');
  const client = new RevolutClient(credentials);
  const validation = await client.validate();
  if (!validation.valid) {
    throw new CliError('AUTH_FAILED', `Could not read accounts: ${validation.error}`);
  }

  console.error(`\nConnected to Revolut ${environment}`);
  console.error(`${validation.info}\n`);

  const profileName = options.profile || environment;

  await setProfile('revolut', profileName, { readOnly: options.readOnly });
  await setCredentials('revolut', profileName, credentials);

  console.log(`\nProfile "${profileName}" configured!`);
  if (options.readOnly) {
    console.log(`   Access: read-only`);
  }
  console.log(`   Test with: agentio revolut accounts --profile ${profileName}`);
}
