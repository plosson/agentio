import { describe, expect, test } from 'bun:test';
import { buildBasename, uniqueBasename } from '../../../src/plugins/falco/naming';
import type { PeppolDocument } from '../../../src/plugins/falco/types';

function peppolDocument(overrides: Partial<PeppolDocument> = {}): PeppolDocument {
  return {
    id: '7f2c1e90-1111-2222-3333-444455556666',
    companyName: null,
    documentNumber: '2026-0042',
    creationDate: null,
    documentDate: '2026-07-14T00:00:00Z',
    dueDate: null,
    downloadDate: null,
    amount: '1210.00',
    currency: 'EUR',
    supplierVatNumber: 'BE0123456789',
    supplierParticipant: null,
    supplierName: 'Acme BV',
    isCreditNote: false,
    invoiceReference: null,
    paymentReference: null,
    bankAccountNumber: null,
    doNotImport: false,
    importState: 'Imported',
    importDate: null,
    fiduciaryDocumentId: null,
    lastInvoiceResponse: null,
    paymentStatus: 'NotPaid',
    comment: null,
    documentType: 'Invoice',
    ...overrides,
  };
}

describe('falco basenames', () => {
  test('combines date, supplier and document number', () => {
    expect(buildBasename(peppolDocument())).toBe('2026-07-14_acme-bv_2026-0042');
  });

  test('folds accents and collapses punctuation in the supplier name', () => {
    expect(buildBasename(peppolDocument({ supplierName: 'Losson & Associés' }))).toBe(
      '2026-07-14_losson-associes_2026-0042',
    );
  });

  test('falls back to the download date, then to a zero date', () => {
    expect(buildBasename(peppolDocument({ documentDate: null, downloadDate: '2026-08-01T10:00:00Z' }))).toStartWith(
      '2026-08-01_',
    );
    expect(buildBasename(peppolDocument({ documentDate: null, downloadDate: null }))).toStartWith('0000-00-00_');
  });

  test('falls back to a short id when no document number exists', () => {
    expect(buildBasename(peppolDocument({ documentNumber: null, invoiceReference: null }))).toBe(
      '2026-07-14_acme-bv_7f2c1e90',
    );
  });

  test('prefers the invoice reference over the document number', () => {
    expect(buildBasename(peppolDocument({ invoiceReference: 'INV/2026/9' }))).toBe('2026-07-14_acme-bv_INV-2026-9');
  });

  test('names an unknown supplier rather than producing an empty segment', () => {
    expect(buildBasename(peppolDocument({ supplierName: null }))).toBe('2026-07-14_unknown_2026-0042');
  });

  test('uniqueBasename only suffixes when the name is taken', () => {
    expect(uniqueBasename('a', () => false)).toBe('a');
    expect(uniqueBasename('a', (candidate) => candidate === 'a')).toBe('a_2');
    const taken = new Set(['a', 'a_2']);
    expect(uniqueBasename('a', (candidate) => taken.has(candidate))).toBe('a_3');
  });
});
