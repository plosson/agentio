import type { BillingDocument, Invoice, PeppolDocument } from './types';

const SUPPLIER_MAX = 40;
const NUMBER_MAX = 30;

function slugify(input: string, maxLen: number): string {
  const stripped = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (stripped.length <= maxLen) return stripped;
  return stripped.slice(0, maxLen).replace(/-+$/g, '');
}

function slugifyNumber(input: string): string {
  const cleaned = input
    .replace(/[/\\:*?"<>|\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length <= NUMBER_MAX) return cleaned;
  return cleaned.slice(0, NUMBER_MAX).replace(/-+$/g, '');
}

function firstTenChars(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return m ? m[1]! : null;
}

/**
 * Compute a filesystem-safe basename (no extension) for a Peppol document.
 *
 * Format: YYYY-MM-DD_<supplier-slug>_<number-slug>
 *   - date  = documentDate | downloadDate | '0000-00-00'
 *   - supplier-slug = NFD-folded, lowercased supplier name (<=40 chars), else 'unknown'
 *   - number-slug   = invoice number or documentNumber, filesystem-cleaned (<=30 chars),
 *                     else short form of the UUID
 */
export function buildBasename(doc: PeppolDocument): string {
  const date =
    firstTenChars(doc.documentDate) ?? firstTenChars(doc.downloadDate) ?? '0000-00-00';

  const supplierRaw = (doc.supplierName ?? '').trim();
  const supplier = slugify(supplierRaw, SUPPLIER_MAX) || 'unknown';

  const numberRaw = (doc.invoiceReference ?? doc.documentNumber ?? '').trim();
  const number = slugifyNumber(numberRaw) || doc.id.slice(0, 8);

  return `${date}_${supplier}_${number}`;
}

/**
 * Compute a filesystem-safe basename for an invoice (from /document/invoices).
 *
 * Format: YYYY-MM-DD_<party-slug>_<number-slug>
 *   - date  = invoiceDate | createdAt | '0000-00-00'
 *   - party = supplierName (purchase) or customerName (sale), else 'unknown'
 *   - number = invoiceReference, else short form of the UUID
 *
 * Credit notes are prefixed with 'CN_' on the number.
 */
export function buildInvoiceBasename(inv: Invoice): string {
  const date =
    firstTenChars(inv.invoiceDate) ?? firstTenChars(inv.createdAt) ?? '0000-00-00';

  const isSale = inv.type === 'SaleInvoice' || inv.type === 'SaleCreditNote';
  const partyRaw = ((isSale ? inv.customerName : inv.supplierName) ?? '').trim();
  const party = slugify(partyRaw, SUPPLIER_MAX) || 'unknown';

  const isCreditNote = inv.type === 'PurchaseCreditNote' || inv.type === 'SaleCreditNote';
  const rawNumber = (inv.invoiceReference ?? '').trim();
  let number = slugifyNumber(rawNumber) || inv.id.slice(0, 8);
  if (isCreditNote) number = `CN_${number}`;

  return `${date}_${party}_${number}`;
}

/**
 * Basename for a billing document (outgoing sales invoice / credit note /
 * estimate / proforma) from the billing API.
 *
 * Format: YYYY-MM-DD_<customer-slug>_<number>[_CN]
 *   - date  = SendDate | CreationDate | '0000-00-00'
 *   - customer = CustomerName, else 'unknown'
 *   - number = DocumentNumber, else short id
 *   - credit notes get a 'CN_' prefix on the number
 */
export function buildBillingBasename(doc: BillingDocument): string {
  const date =
    firstTenChars(doc.SendDate) ?? firstTenChars(doc.CreationDate) ?? '0000-00-00';
  const customer = slugify((doc.CustomerName ?? '').trim(), SUPPLIER_MAX) || 'unknown';
  const rawNumber = doc.DocumentNumber != null ? String(doc.DocumentNumber) : '';
  let number = slugifyNumber(rawNumber) || doc.Id.slice(0, 8);
  if (doc.Type === "CreditNote") number = `CN_${number}`;
  return `${date}_${customer}_${number}`;
}

/**
 * Resolve collisions: if `proposed` is already taken by a *different* id in
 * `takenByOther`, append `_2`, `_3`, ... until unique.
 */
export function uniqueBasename(
  proposed: string,
  isTaken: (basename: string) => boolean,
): string {
  if (!isTaken(proposed)) return proposed;
  for (let n = 2; n < 100; n++) {
    const candidate = `${proposed}_${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  // Fallback: append a tiny random hex. 6 hex chars = 16 M combos — effectively unique.
  const hex = Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, '0');
  return `${proposed}_${hex}`;
}
