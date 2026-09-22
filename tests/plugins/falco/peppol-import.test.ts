import { describe, expect, test } from 'bun:test';
import { resolveImportPeppolDocument } from '../../../src/plugins/falco/commands';
import type { PeppolDocument } from '../../../src/plugins/falco/types';
import { CliError } from '../../../src/utils/errors';

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
    importState: 'NotImported',
    importDate: null,
    fiduciaryDocumentId: 'fid-1',
    lastInvoiceResponse: null,
    paymentStatus: 'NotPaid',
    comment: null,
    documentType: 'Invoice',
    ...overrides,
  };
}

describe('resolveImportPeppolDocument', () => {
  test('matches by id, invoice reference, document number, fiduciary id, or payment reference', () => {
    const doc = peppol({ paymentReference: '+++123/456/789+++' });
    for (const ref of ['pep-2', 'DT20261474', 'fid-1', '+++123/456/789+++']) {
      expect(resolveImportPeppolDocument(ref, [doc]).id).toBe('pep-2');
    }
  });

  test('throws when several documents share the same reference', () => {
    const error = (() => {
      try {
        resolveImportPeppolDocument('SAME', [
          peppol({ id: 'a', invoiceReference: 'SAME' }),
          peppol({ id: 'b', invoiceReference: 'SAME', documentNumber: 'OTHER' }),
        ]);
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error!.code).toBe('INVALID_PARAMS');
    expect(error!.message).toContain('matches 2');
  });

  test('throws NOT_FOUND when nothing matches', () => {
    const error = (() => {
      try {
        resolveImportPeppolDocument('missing', [peppol()]);
        return null;
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(error).toBeInstanceOf(CliError);
    expect(error!.code).toBe('NOT_FOUND');
  });
});
