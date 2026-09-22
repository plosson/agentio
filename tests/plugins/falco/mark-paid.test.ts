import { describe, expect, test } from 'bun:test';
import { resolveMarkPaidTarget } from '../../../src/plugins/falco/commands';
import type { Invoice, PeppolDocument } from '../../../src/plugins/falco/types';
import { CliError } from '../../../src/utils/errors';

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    peppolInvoiceId: 'pep-1',
    type: 'PurchaseInvoice',
    status: null,
    paymentStatus: 'NotPaid',
    peppolStatus: null,
    origin: null,
    createdAt: null,
    invoiceDate: null,
    invoiceDueDate: null,
    amount: '10.00',
    invoiceCurrency: 'EUR',
    invoiceReference: 'INV-1',
    paymentReference: null,
    bankAccountNumber: null,
    supplierId: null,
    supplierName: 'Acme',
    customerName: null,
    name: null,
    category: null,
    fiduciaryId: null,
    fiduciaryStatus: null,
    files: [],
    ...overrides,
  };
}

function peppol(overrides: Partial<PeppolDocument> = {}): PeppolDocument {
  return {
    id: 'pep-2',
    companyName: null,
    documentNumber: 'DT20261474',
    creationDate: null,
    documentDate: '2026-08-18',
    dueDate: null,
    downloadDate: null,
    amount: '366.03',
    currency: 'EUR',
    supplierVatNumber: null,
    supplierParticipant: null,
    supplierName: 'Silversquare Belgium',
    isCreditNote: false,
    invoiceReference: 'DT20261474',
    paymentReference: null,
    bankAccountNumber: null,
    doNotImport: false,
    importState: 'Imported',
    importDate: null,
    fiduciaryDocumentId: 'fid-1',
    lastInvoiceResponse: null,
    paymentStatus: 'NotPaid',
    comment: null,
    documentType: 'Invoice',
    ...overrides,
  };
}

describe('resolveMarkPaidTarget', () => {
  test('prefers the invoice register when a Peppol id is also present there', () => {
    const target = resolveMarkPaidTarget('pep-1', [invoice()], [peppol({ id: 'pep-1' })]);
    expect(target).toEqual({ source: 'invoice', invoice: invoice() });
  });

  test('matches invoices by id, peppolInvoiceId, or invoiceReference', () => {
    const inv = invoice();
    expect(resolveMarkPaidTarget('inv-1', [inv], []).source).toBe('invoice');
    expect(resolveMarkPaidTarget('pep-1', [inv], []).source).toBe('invoice');
    expect(resolveMarkPaidTarget('INV-1', [inv], []).source).toBe('invoice');
  });

  test('falls back to the Peppol inbox when the invoice register has no match', () => {
    const doc = peppol();
    for (const ref of ['pep-2', 'DT20261474', 'fid-1']) {
      const target = resolveMarkPaidTarget(ref, [invoice()], [doc]);
      expect(target).toEqual({ source: 'peppol', document: doc });
    }
  });

  test('matches Peppol paymentReference too', () => {
    const doc = peppol({ paymentReference: '+++123/456/789+++' });
    expect(resolveMarkPaidTarget('+++123/456/789+++', [], [doc]).source).toBe('peppol');
  });

  test('throws NOT_FOUND when neither register has a match', () => {
    const error = (() => {
      try {
        resolveMarkPaidTarget('missing', [invoice()], [peppol()]);
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error!.code).toBe('NOT_FOUND');
  });

  test('throws INVALID_PARAMS when several invoices match', () => {
    const error = (() => {
      try {
        resolveMarkPaidTarget('INV-1', [invoice({ id: 'a' }), invoice({ id: 'b' })], []);
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error!.code).toBe('INVALID_PARAMS');
    expect(error!.message).toContain('2 invoices');
  });

  test('throws INVALID_PARAMS when several Peppol documents match', () => {
    const error = (() => {
      try {
        resolveMarkPaidTarget('DT20261474', [], [peppol({ id: 'a' }), peppol({ id: 'b' })]);
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error!.code).toBe('INVALID_PARAMS');
    expect(error!.message).toContain('2 Peppol documents');
  });
});
