import type { BillingDocument, Invoice, PeppolDocument } from './types';

const DASH = '—';

function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : DASH;
}

function fmtAmount(amount: string | null, currency: string | null): string {
  if (!amount) return DASH;
  const symbol = currency === 'EUR' ? '€' : (currency ?? '');
  return `${amount} ${symbol}`.trim();
}

/** Left-align, truncating with an ellipsis so columns never drift. */
function pad(value: string, width: number): string {
  if (value.length >= width) return `${value.slice(0, width - 1)}…`;
  return value + ' '.repeat(width - value.length);
}

/** Right-align, same truncation rule. */
function padLeft(value: string, width: number): string {
  if (value.length >= width) return `${value.slice(0, width - 1)}…`;
  return ' '.repeat(width - value.length) + value;
}

export function printPeppolDocuments(documents: PeppolDocument[]): void {
  if (documents.length === 0) {
    console.log('No Peppol documents match.');
    return;
  }

  const header =
    pad('DATE', 11) + pad('NUMBER', 18) + pad('SUPPLIER', 40) + padLeft('AMOUNT', 14) + '  ' + pad('STATE', 14) + 'ID';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const document of documents) {
    const supplier = `${document.supplierName ?? '?'}${
      document.supplierVatNumber ? ` (${document.supplierVatNumber})` : ''
    }`;
    console.log(
      pad(fmtDate(document.documentDate), 11) +
        pad(document.documentNumber ?? DASH, 18) +
        pad(supplier, 40) +
        padLeft(fmtAmount(document.amount, document.currency), 14) +
        '  ' +
        pad(document.importState ?? DASH, 14) +
        document.id,
    );
  }
  console.log(`\n${documents.length} document(s)`);
}

export function describeInvoice(invoice: Invoice): string {
  const amount = fmtAmount(invoice.amount, invoice.invoiceCurrency);
  return `${invoice.invoiceReference ?? invoice.id} (${invoice.supplierName ?? '?'}, ${amount})`;
}

/** Same shape as describeInvoice, for Peppol inbox rows that never reach /document/invoices. */
export function describePeppolPaymentTarget(document: PeppolDocument): string {
  const amount = fmtAmount(document.amount, document.currency);
  const ref = document.invoiceReference ?? document.documentNumber ?? document.id;
  return `${ref} (${document.supplierName ?? '?'}, ${amount})`;
}

export function printPaymentStatusChange(label: string, from: string | null, to: string, confirmed: boolean): void {
  console.error(`${label}: ${from ?? '?'} -> ${to}${confirmed ? ' ✓' : ' (unverified)'}`);
}

export function printFileWritten(path: string, bytes: number, note?: string): void {
  console.error(`wrote ${path} (${bytes} bytes${note ? `, ${note}` : ''})`);
}

export function describeBillingDocument(document: BillingDocument): string {
  const date = fmtDate(document.SendDate ?? document.CreationDate);
  return `${date}  ${document.CustomerName ?? '?'}  ${document.FinalAmount ?? '?'} ${document.CurrencyCode ?? ''}`.trim();
}

export interface SyncTally {
  wrote: number;
  skipped: number;
  renamed: number;
  failed: number;
  pdfsEmbedded?: number;
  pdfsRendered?: number;
}

export function printSyncSummary(tally: SyncTally, directory: string): void {
  const parts = [
    `${tally.wrote} downloaded`,
    `${tally.skipped} already on disk`,
    `${tally.renamed} renamed`,
    `${tally.failed} failed`,
  ];
  if (tally.pdfsEmbedded !== undefined || tally.pdfsRendered !== undefined) {
    parts.push(`${tally.pdfsEmbedded ?? 0} PDFs extracted`, `${tally.pdfsRendered ?? 0} PDFs rendered`);
  }
  console.log(`\nDone: ${parts.join(', ')}. Dir: ${directory}`);
}

export function describePeppolDocument(document: PeppolDocument): string {
  return `${fmtDate(document.documentDate)}  ${document.supplierName ?? '?'}  ${fmtAmount(
    document.amount,
    document.currency,
  )}`;
}
