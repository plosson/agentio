import { Command } from 'commander';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chooseProfileName, saveProfile } from '../../config/profile-store';
import { addExamples } from '../../utils/command-tree';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import type { ProfileAddOptions } from '../types';
import { loginToFalco } from './auth';
import { FalcoClient } from './client';
import { loadManifest, saveManifest } from './manifest';
import { buildBasename, buildBillingBasename, uniqueBasename } from './naming';
import {
  describeBillingDocument,
  describeInvoice,
  printFileWritten,
  printPaymentStatusChange,
  printPeppolDocuments,
  printSyncSummary,
  type SyncTally,
} from './output';
import { promptChoice, promptPassword, promptText } from './prompts';
import { extractEmbeddedPdf } from './ubl';
import { renderUblXmlToPdf } from './ubl-render';
import type { BillingDocument, FalcoCredentials, InvoicePaymentStatus, PeppolDocument } from './types';

const getFalcoClient = createClientGetter<FalcoCredentials, FalcoClient>({
  service: 'falco',
  createClient: (credentials) => new FalcoClient(credentials),
});

const PROFILE_OPTION = 'Profile name (optional if only one profile exists)';
const DEFAULT_BILLING_TYPES = 'Invoice,CreditNote';

// --- Shared helpers ---------------------------------------------------------

function requireIsoDate(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CliError('INVALID_PARAMS', `${flag} must be YYYY-MM-DD, got: ${value}`);
  }
  return value;
}

function containsInsensitive(haystack: string | null, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Client-side filtering; the Peppol endpoint has no server-side equivalents. */
function filterPeppolDocuments(
  documents: PeppolDocument[],
  filters: { since?: string; sender?: string },
): PeppolDocument[] {
  let result = documents;
  if (filters.since) {
    result = result.filter((d) => (d.documentDate ?? '').slice(0, 10) >= filters.since!);
  }
  if (filters.sender) {
    const needle = filters.sender.toLowerCase();
    result = result.filter(
      (d) => containsInsensitive(d.supplierVatNumber, needle) || containsInsensitive(d.supplierName, needle),
    );
  }
  return result;
}

/** Move `<base>.xml` and `<base>.pdf` together; either may be absent. */
async function renamePair(directory: string, from: string, to: string): Promise<void> {
  for (const extension of ['.xml', '.pdf']) {
    const source = join(directory, from + extension);
    if (await fileExists(source)) await rename(source, join(directory, to + extension));
  }
}

async function renameOne(directory: string, from: string, to: string, extension = '.pdf'): Promise<void> {
  const source = join(directory, from + extension);
  if (await fileExists(source)) await rename(source, join(directory, to + extension));
}

/**
 * Resolve the on-disk basename for a document, creating or correcting the
 * manifest entry. The manifest is what makes a re-run incremental: the
 * human-readable name is derived, so the document id cannot be recovered from
 * the filename alone.
 */
export async function resolveBasename(
  id: string,
  proposed: string,
  manifest: { entries: Record<string, string> },
  basenameToId: Map<string, string>,
  onRename: (from: string, to: string) => Promise<void>,
): Promise<{ basename: string; renamed: boolean }> {
  const taken = (candidate: string) => {
    const owner = basenameToId.get(candidate);
    return owner !== undefined && owner !== id;
  };

  const existing = manifest.entries[id];
  if (!existing) {
    const basename = uniqueBasename(proposed, taken);
    manifest.entries[id] = basename;
    basenameToId.set(basename, id);
    return { basename, renamed: false };
  }

  // Upstream metadata can change (a corrected date or counterparty), which
  // changes the derived name; move the files rather than orphaning them.
  const target = uniqueBasename(proposed, taken);
  if (target === existing) return { basename: existing, renamed: false };

  basenameToId.delete(existing);
  basenameToId.set(target, id);
  await onRename(existing, target);
  manifest.entries[id] = target;
  return { basename: target, renamed: true };
}

export function indexManifest(entries: Record<string, string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const [id, basename] of Object.entries(entries)) index.set(basename, id);
  return index;
}

// --- profile add ------------------------------------------------------------

/**
 * Falco authenticates with email + password and an optional second factor, so
 * this is an interactive flow rather than an OAuth redirect. The organization
 * is picked once and stored with the credentials, because every data endpoint
 * is org-scoped.
 */
export async function falcoProfileAdd(options: ProfileAddOptions): Promise<void> {
  console.error('\nFalco Setup\n');

  const email = await promptText('? Email:');
  if (!email) throw new CliError('INVALID_PARAMS', 'An email address is required');
  const password = await promptPassword('? Password:');
  if (!password) throw new CliError('INVALID_PARAMS', 'A password is required');

  let result = await loginToFalco({ username: email, password });
  if (result.type === 'two_factor_required') {
    const code = await promptText('? Two-factor code:');
    result = await loginToFalco({ username: email, password, twoFaCode: code });
  }
  if (result.type !== 'success') {
    throw new CliError('AUTH_FAILED', 'Falco asked for a two-factor code that was not supplied');
  }

  const now = Date.now();
  const tokens = result.tokens;

  // A client scoped to no organization can still read /user/me, which is what
  // supplies the organization list.
  const bootstrap = new FalcoClient({
    refreshToken: tokens.refreshToken,
    refreshExpiryDate: now + tokens.refreshTokenExpiresIn * 1000,
    accessToken: tokens.accessToken,
    expiryDate: now + tokens.expiresIn * 1000,
    organizationId: '',
    userId: '',
    userEmail: email,
  });
  const me = await bootstrap.getUserMe();
  if (!me.organizations?.length) {
    throw new CliError('CONFIG_ERROR', 'This Falco account has no organizations');
  }

  const organization = await promptChoice(
    'Organization',
    me.organizations.map((org) => ({
      name: `${org.name}${org.vatNumber ? ` — ${org.vatNumber}` : ''}`,
      value: org,
    })),
  );

  const credentials: FalcoCredentials = {
    refreshToken: tokens.refreshToken,
    refreshExpiryDate: now + tokens.refreshTokenExpiresIn * 1000,
    accessToken: tokens.accessToken,
    expiryDate: now + tokens.expiresIn * 1000,
    organizationId: organization.id,
    organizationName: organization.name,
    userId: me.id,
    userEmail: me.email,
  };

  const profileName = await chooseProfileName('falco', {
    explicit: options.profile,
    derived: slugifyOrganization(organization.name),
    readOnly: options.readOnly,
  });
  await saveProfile('falco', profileName, credentials, { readOnly: options.readOnly });

  console.error(`\n  Profile "${profileName}" saved`);
  console.error(`  ${me.firstName} ${me.lastName} <${me.email}>`);
  console.error(`  Organization: ${organization.name} (${organization.id})`);
}

/** "Acme BV" -> "acme-bv"; falls back to "falco" when nothing usable remains. */
export function slugifyOrganization(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'falco';
}

// --- Command registration ---------------------------------------------------

export function registerFalcoCommands(program: Command): void {
  const falco = program.command('falco').description('Falco accounting and Peppol operations');
  const peppol = falco.command('peppol').description('Inbound Peppol documents');

  addExamples(
    peppol
      .command('list')
      .description('List inbound Peppol documents')
      .option('--profile <name>', PROFILE_OPTION)
      .option('--since <date>', 'Only documents dated on or after YYYY-MM-DD')
      .option('--sender <text>', 'Only documents whose supplier name or VAT number contains this')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (options) => {
        try {
          const since = requireIsoDate(options.since, '--since');
          const { client } = await getFalcoClient(options.profile);
          const documents = filterPeppolDocuments(await client.listPeppolDocuments(), {
            since,
            sender: options.sender,
          });

          if (options.format === 'json') {
            console.log(JSON.stringify(documents, null, 2));
            return;
          }
          printPeppolDocuments(documents);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # everything in the inbox
  agentio falco peppol list

  # this quarter, from one supplier
  agentio falco peppol list --since 2026-07-01 --sender BE0123456789

  # machine-readable
  agentio falco peppol list --format json`,
  );

  addExamples(
    peppol
      .command('get')
      .description('Download the UBL XML of one Peppol document')
      .argument('<id>', 'Peppol document ID')
      .option('--profile <name>', PROFILE_OPTION)
      .option('--output <path>', 'File, directory, or "-" for stdout (default: <id>.xml)')
      .option('--extract-pdf', 'Also write a PDF next to the XML')
      .action(async (id: string, options) => {
        try {
          const { client } = await getFalcoClient(options.profile);
          const payload = await client.downloadPeppolDocumentUbl(id);
          const xml = new TextDecoder('utf-8').decode(payload.bytes);

          const toStdout = options.output === '-';
          let xmlPath = `${id}.xml`;
          if (toStdout) {
            process.stdout.write(xml.endsWith('\n') ? xml : `${xml}\n`);
          } else {
            if (options.output) {
              xmlPath = (await isDirectory(options.output))
                ? join(options.output, `${id}.xml`)
                : options.output;
              const parent = dirname(xmlPath);
              if (parent && parent !== '.') await mkdir(parent, { recursive: true });
            }
            await writeFile(xmlPath, payload.bytes);
            printFileWritten(xmlPath, payload.bytes.byteLength);
          }

          if (!options.extractPdf) return;

          // A Peppol UBL document may carry a PDF rendition; when it does not,
          // one is rendered from the parsed invoice instead. Streaming the XML
          // to stdout still writes the PDF next to the working directory.
          const pdfPath = toStdout ? `${id}.pdf` : `${xmlPath.replace(/\.xml$/i, '')}.pdf`;
          const embedded = extractEmbeddedPdf(xml);
          const bytes = embedded ? embedded.bytes : await renderUblXmlToPdf(xml);
          const note = embedded
            ? `extracted${embedded.filename ? ` [original name: ${embedded.filename}]` : ''}`
            : 'rendered from UBL';
          await writeFile(pdfPath, bytes);
          printFileWritten(pdfPath, bytes.byteLength, note);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # write <id>.xml into the working directory
  agentio falco peppol get 7f2c1e90-...

  # XML plus a PDF, into a folder
  agentio falco peppol get 7f2c1e90-... --output ./inbox --extract-pdf

  # pipe the XML somewhere else
  agentio falco peppol get 7f2c1e90-... --output -`,
  );

  addExamples(
    peppol
      .command('sync')
      .description('Download every matching Peppol document into a directory')
      .requiredOption('--output <dir>', 'Target directory (created if missing)')
      .option('--profile <name>', PROFILE_OPTION)
      .option('--since <date>', 'Only documents dated on or after YYYY-MM-DD')
      .option('--sender <text>', 'Only documents whose supplier name or VAT number contains this')
      .option('--extract-pdf', 'Ensure a PDF exists for every document')
      .option('--force', 'Re-download documents already on disk')
      .action(async (options) => {
        try {
          await runPeppolSync(options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # mirror the whole inbox, XML only
  agentio falco peppol sync --output ./peppol

  # XML plus PDFs, this year only
  agentio falco peppol sync --output ./peppol --since 2026-01-01 --extract-pdf

  # re-download everything
  agentio falco peppol sync --output ./peppol --force`,
  );

  addExamples(
    peppol
      .command('mark-paid')
      .description('Set the payment status of an invoice')
      .argument('<ref>', 'Peppol document ID, invoice ID, or invoice reference')
      .option('--profile <name>', PROFILE_OPTION)
      .option('--status <status>', 'Paid or NotPaid', 'Paid')
      .option('--unpaid', 'Shortcut for --status NotPaid')
      .option('--format <format>', 'Output format: text or json', 'text')
      .action(async (ref: string, options) => {
        try {
          await runMarkPaid(ref, options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # mark an invoice paid, by reference
  agentio falco peppol mark-paid INV-2026-0042

  # undo it
  agentio falco peppol mark-paid INV-2026-0042 --unpaid

  # by Peppol document id, printing the updated record
  agentio falco peppol mark-paid 7f2c1e90-... --format json`,
  );

  const invoices = falco.command('invoices').description('Outbound billing documents');

  addExamples(
    invoices
      .command('sync')
      .description('Download outbound billing document PDFs into a directory')
      .requiredOption('--output <dir>', 'Target directory (created if missing)')
      .option('--profile <name>', PROFILE_OPTION)
      .option('--since <date>', 'Only documents sent or created on or after YYYY-MM-DD')
      .option('--customer <text>', 'Only documents whose customer name contains this')
      .option('--include <types>', 'Comma-separated document types', DEFAULT_BILLING_TYPES)
      .option('--force', 'Re-download documents already on disk')
      .action(async (options) => {
        try {
          await runInvoicesSync(options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # every sales invoice and credit note
  agentio falco invoices sync --output ./sales

  # invoices only, since the start of the quarter
  agentio falco invoices sync --output ./sales --include Invoice --since 2026-07-01

  # one customer
  agentio falco invoices sync --output ./sales --customer "Acme"`,
  );

  const profile = createProfileCommands<FalcoCredentials>(falco, {
    service: 'falco',
    displayName: 'Falco',
    getExtraInfo: (credentials) =>
      credentials ? ` - ${credentials.userEmail} (${credentials.organizationName ?? credentials.organizationId})` : '',
  });

  addExamples(
    profile
      .command('add')
      .description('Add a new Falco profile')
      .option('--profile <name>', 'Profile name (defaults to a slug of the organization)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(async (options) => {
        try {
          await falcoProfileAdd(options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # log in and pick an organization
  agentio falco profile add

  # name the profile yourself
  agentio falco profile add --profile letschill

  # a profile that cannot change payment status
  agentio falco profile add --profile audit --read-only`,
  );
}

// --- Command bodies ---------------------------------------------------------

interface PeppolSyncOptions {
  profile?: string;
  output: string;
  since?: string;
  sender?: string;
  extractPdf?: boolean;
  force?: boolean;
}

async function runPeppolSync(options: PeppolSyncOptions): Promise<void> {
  const since = requireIsoDate(options.since, '--since');
  const { client } = await getFalcoClient(options.profile);
  await mkdir(options.output, { recursive: true });

  const all = await client.listAllPeppolDocuments({}, (page, added, total) => {
    console.error(`  [page ${page + 1}] +${added} (total so far: ${total})`);
  });
  const documents = filterPeppolDocuments(all, { since, sender: options.sender });
  if (documents.length === 0) {
    console.log('No matching documents.');
    return;
  }

  const manifest = await loadManifest(options.output);
  const basenameToId = indexManifest(manifest.entries);
  const tally: SyncTally = { wrote: 0, skipped: 0, renamed: 0, failed: 0, pdfsEmbedded: 0, pdfsRendered: 0 };

  for (const document of documents) {
    const { basename, renamed } = await resolveBasename(
      document.id,
      buildBasename(document),
      manifest,
      basenameToId,
      (from, to) => renamePair(options.output, from, to),
    );
    if (renamed) tally.renamed += 1;

    const xmlPath = join(options.output, `${basename}.xml`);
    const pdfPath = join(options.output, `${basename}.pdf`);
    const haveXml = await fileExists(xmlPath);
    const needPdf = !!options.extractPdf && !(await fileExists(pdfPath));

    if (haveXml && !needPdf && !options.force) {
      tally.skipped += 1;
      continue;
    }

    let xml: string;
    try {
      if (haveXml && !options.force) {
        xml = await Bun.file(xmlPath).text();
      } else {
        const payload = await client.downloadPeppolDocumentUbl(document.id);
        xml = new TextDecoder('utf-8').decode(payload.bytes);
        await writeFile(xmlPath, payload.bytes);
        tally.wrote += 1;
      }
    } catch (error) {
      console.error(`  ✗ ${basename} — ${error instanceof Error ? error.message : String(error)}`);
      tally.failed += 1;
      continue;
    }

    if (options.extractPdf && (options.force || !(await fileExists(pdfPath)))) {
      try {
        const embedded = extractEmbeddedPdf(xml);
        const bytes = embedded ? embedded.bytes : await renderUblXmlToPdf(xml);
        await writeFile(pdfPath, bytes);
        if (embedded) tally.pdfsEmbedded! += 1;
        else tally.pdfsRendered! += 1;
      } catch (error) {
        console.error(`  ✗ ${basename}.pdf — ${error instanceof Error ? error.message : String(error)}`);
        tally.failed += 1;
        continue;
      }
    }

    console.log(`  ✓ ${basename}`);
  }

  await saveManifest(options.output, manifest);
  printSyncSummary(tally, options.output);
}

interface InvoicesSyncOptions {
  profile?: string;
  output: string;
  since?: string;
  customer?: string;
  include: string;
  force?: boolean;
}

async function runInvoicesSync(options: InvoicesSyncOptions): Promise<void> {
  const since = requireIsoDate(options.since, '--since');
  const types = new Set(
    options.include
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (types.size === 0) throw new CliError('INVALID_PARAMS', '--include needs at least one document type');

  const { client } = await getFalcoClient(options.profile);
  await mkdir(options.output, { recursive: true });

  let documents: BillingDocument[] = await client.listBillingDocuments({
    Invoices: types.has('Invoice'),
    CreditNotes: types.has('CreditNote'),
    Estimates: types.has('Estimate'),
    AdvancePayments: types.has('AdvancePayment'),
    Proformas: types.has('Proforma'),
  });

  if (since) {
    documents = documents.filter((d) => (d.SendDate ?? d.CreationDate ?? '').slice(0, 10) >= since);
  }
  if (options.customer) {
    const needle = options.customer.toLowerCase();
    documents = documents.filter((d) => containsInsensitive(d.CustomerName, needle));
  }
  // The endpoint can be over-inclusive, so filter to what was actually asked for.
  documents = documents.filter((d) => types.has(d.Type));

  if (documents.length === 0) {
    console.log('No billing documents match.');
    return;
  }

  const manifest = await loadManifest(options.output);
  const basenameToId = indexManifest(manifest.entries);
  const tally: SyncTally = { wrote: 0, skipped: 0, renamed: 0, failed: 0 };

  for (const document of documents) {
    const { basename, renamed } = await resolveBasename(
      document.Id,
      buildBillingBasename(document),
      manifest,
      basenameToId,
      (from, to) => renameOne(options.output, from, to),
    );
    if (renamed) tally.renamed += 1;

    const pdfPath = join(options.output, `${basename}.pdf`);
    if (!options.force && (await fileExists(pdfPath))) {
      tally.skipped += 1;
      continue;
    }

    try {
      const payload = await client.downloadBillingDocumentPdf(document.Id);
      await writeFile(pdfPath, payload.bytes);
      tally.wrote += 1;
      console.log(`  ✓ ${basename}  (${describeBillingDocument(document)})`);
    } catch (error) {
      console.error(`  ✗ ${basename} — ${error instanceof Error ? error.message : String(error)}`);
      tally.failed += 1;
    }
  }

  await saveManifest(options.output, manifest);
  printSyncSummary(tally, options.output);
}

interface MarkPaidOptions {
  profile?: string;
  status: string;
  unpaid?: boolean;
  format: string;
}

async function runMarkPaid(ref: string, options: MarkPaidOptions): Promise<void> {
  const status: InvoicePaymentStatus = options.unpaid ? 'NotPaid' : (options.status as InvoicePaymentStatus);
  if (status !== 'Paid' && status !== 'NotPaid') {
    throw new CliError('INVALID_PARAMS', `--status must be Paid or NotPaid, got: ${options.status}`);
  }

  const { client, profile } = await getFalcoClient(options.profile);
  await enforceWriteAccess('falco', profile, 'mark an invoice as paid');

  const invoices = await client.listAllInvoices();
  const matches = invoices.filter((i) => i.id === ref || i.peppolInvoiceId === ref || i.invoiceReference === ref);

  if (matches.length === 0) {
    throw new CliError(
      'NOT_FOUND',
      `No invoice matches "${ref}"`,
      'Pass a Peppol document id, invoice id, or invoice reference. Run: agentio falco peppol list',
    );
  }
  if (matches.length > 1) {
    const lines = matches
      .map((i) => `  ${i.invoiceReference ?? '(no ref)'}  id=${i.id}  peppol=${i.peppolInvoiceId ?? '-'}`)
      .join('\n');
    throw new CliError('INVALID_PARAMS', `"${ref}" matches ${matches.length} invoices:\n${lines}`, 'Re-run with the invoice id');
  }

  const invoice = matches[0]!;
  const label = describeInvoice(invoice);

  if (invoice.paymentStatus === status) {
    console.error(`${label} is already ${status}; nothing to do.`);
    if (options.format === 'json') console.log(JSON.stringify(invoice, null, 2));
    return;
  }

  await client.setInvoicePaymentStatus(invoice.id, status);

  // Falco accepts the write before it is visible, so confirm by re-reading.
  const after = await client.listAllInvoices();
  const updated = after.find((i) => i.id === invoice.id);
  const confirmed = updated?.paymentStatus === status;

  printPaymentStatusChange(label, invoice.paymentStatus, updated?.paymentStatus ?? status, confirmed);
  if (options.format === 'json' && updated) console.log(JSON.stringify(updated, null, 2));
  if (!confirmed) {
    throw new CliError('API_ERROR', 'Falco accepted the change but it is not visible yet', 'Re-run to check');
  }
}
