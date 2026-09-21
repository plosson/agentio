import { describe, expect, test } from 'bun:test';
import { describeInvoice } from '../../../src/plugins/falco/output';
import type { Invoice } from '../../../src/plugins/falco/types';

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    peppolInvoiceId: null,
    type: 'PurchaseInvoice',
    status: null,
    paymentStatus: 'NotPaid',
    peppolStatus: null,
    origin: null,
    createdAt: null,
    invoiceDate: '2026-07-14',
    invoiceDueDate: null,
    amount: '1210.00',
    invoiceCurrency: 'EUR',
    invoiceReference: 'INV-2026-0042',
    paymentReference: null,
    bankAccountNumber: null,
    supplierId: null,
    supplierName: 'Acme BV',
    customerName: null,
    name: null,
    category: null,
    fiduciaryId: null,
    fiduciaryStatus: null,
    files: [],
    ...overrides,
  };
}

describe('describeInvoice', () => {
  test('uses the euro sign for EUR', () => {
    expect(describeInvoice(invoice())).toBe('INV-2026-0042 (Acme BV, 1210.00 €)');
  });

  test('uses the invoice currency rather than assuming euros', () => {
    expect(describeInvoice(invoice({ invoiceCurrency: 'USD' }))).toContain('1210.00 USD');
  });

  test('falls back to the id when there is no reference', () => {
    expect(describeInvoice(invoice({ invoiceReference: null }))).toStartWith('inv-1 (');
  });

  test('tolerates a missing amount', () => {
    expect(describeInvoice(invoice({ amount: null }))).toContain('—');
  });
});
