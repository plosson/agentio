import { Command } from 'commander';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { createPrivateKey } from 'crypto';
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
} from '../utils/output';
import type { RevolutCredentials, RevolutEnvironment } from '../types/revolut';

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

function parseEnvironment(value: string): RevolutEnvironment {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'production' || normalized === 'prod') return 'production';
  if (normalized === 'sandbox') return 'sandbox';
  throw new CliError('INVALID_PARAMS', `Unknown environment "${value}"`, 'Use production or sandbox');
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
