import { afterEach, describe, expect, test } from 'bun:test';
import { RevolutClient } from './client';
import type { RevolutCredentials } from '../../types/revolut';

const CREDENTIALS: RevolutCredentials = {
  environment: 'sandbox',
  clientId: 'client-id',
  privateKey: 'pem',
  redirectUri: 'https://example.com/callback',
  accessToken: 'token',
  refreshToken: 'refresh',
  expiryDate: Date.now() + 60_000,
};

const BASE = 'https://sandbox-b2b.revolut.com/api/1.0';

interface Captured {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

const originalFetch = globalThis.fetch;
const captured: Captured[] = [];

function stubFetch(response: unknown, status = 200): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });

    if (status === 204) {
      return new Response(null, { status });
    }
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  captured.length = 0;
});

function client(): RevolutClient {
  return new RevolutClient(CREDENTIALS);
}

describe('createTransfer', () => {
  test('sends source and target account IDs', async () => {
    stubFetch({
      id: 'tx-3',
      state: 'completed',
      created_at: '2026-09-06T10:00:00Z',
      completed_at: '2026-09-06T10:00:01Z',
    });

    const result = await client().createTransfer({
      requestId: 'req-3',
      sourceAccountId: 'acc-1',
      targetAccountId: 'acc-2',
      amount: 500,
      currency: 'EUR',
      reference: 'Top up',
    });

    expect(captured[0]?.url).toBe(`${BASE}/transfer`);
    expect(captured[0]?.body).toEqual({
      request_id: 'req-3',
      source_account_id: 'acc-1',
      target_account_id: 'acc-2',
      amount: 500,
      currency: 'EUR',
      reference: 'Top up',
    });
    expect(result.completedAt).toBe('2026-09-06T10:00:01Z');
  });
});

describe('payment drafts', () => {
  test('wraps the single payment in a payments array and returns the draft ID', async () => {
    stubFetch({ id: 'draft-1' });

    const id = await client().createPaymentDraft({
      title: 'October rent',
      scheduleFor: '2026-10-01',
      accountId: 'acc-1',
      counterpartyId: 'cp-1',
      amount: 1200,
      currency: 'EUR',
      reference: 'Rent',
    });

    expect(id).toBe('draft-1');
    expect(captured[0]?.url).toBe(`${BASE}/payment-drafts`);
    expect(captured[0]?.body).toEqual({
      payments: [
        {
          account_id: 'acc-1',
          receiver: { counterparty_id: 'cp-1' },
          amount: 1200,
          currency: 'EUR',
          reference: 'Rent',
        },
      ],
      title: 'October rent',
      schedule_for: '2026-10-01',
    });
  });

  test('list unwraps payment_orders and passes the source filter', async () => {
    stubFetch({
      payment_orders: [
        { id: 'draft-1', title: 'Rent', scheduled_for: '2026-10-01', payments_count: 2, source: 'api' },
      ],
    });

    const drafts = await client().listPaymentDrafts('all');

    expect(captured[0]?.url).toBe(`${BASE}/payment-drafts?source=all`);
    expect(drafts).toEqual([
      { id: 'draft-1', title: 'Rent', scheduledFor: '2026-10-01', paymentsCount: 2, source: 'api' },
    ]);
  });

  test('get reads the amount out of its currency wrapper', async () => {
    stubFetch({
      title: 'Rent',
      payments: [
        {
          id: 'pay-1',
          amount: { amount: 123, currency: 'GBP' },
          account_id: 'acc-1',
          receiver: { counterparty_id: 'cp-1' },
          state: 'CREATED',
          current_charge_options: {
            from: { amount: 123, currency: 'GBP' },
            to: { amount: 123, currency: 'GBP' },
            rate: '1.0000',
            fee: { amount: 0, currency: 'GBP' },
          },
        },
      ],
    });

    const draft = await client().getPaymentDraft('draft-1');

    expect(draft.payments[0]?.amount).toBe(123);
    expect(draft.payments[0]?.currency).toBe('GBP');
    expect(draft.payments[0]?.counterpartyId).toBe('cp-1');
    expect(draft.payments[0]?.charge?.rate).toBe('1.0000');
  });
});

describe('payout links', () => {
  test('list maps a link and defaults the absent fields', async () => {
    stubFetch([
      {
        id: 'link-1',
        state: 'active',
        created_at: '2026-09-06T10:00:00Z',
        updated_at: '2026-09-06T10:00:00Z',
        counterparty_name: 'Jane Doe',
        request_id: 'req-4',
        account_id: 'acc-1',
        amount: 50,
        currency: 'EUR',
        reference: 'Expenses',
        url: 'https://business.revolut.com/p/abc',
      },
    ]);

    const links = await client().listPayoutLinks({ limit: 10 });

    expect(captured[0]?.url).toBe(`${BASE}/payout-links?limit=10`);
    expect(links[0]?.url).toBe('https://business.revolut.com/p/abc');
    expect(links[0]?.payoutMethods).toEqual([]);
    expect(links[0]?.saveCounterparty).toBe(false);
  });

  test('cancel posts to the cancel path and tolerates an empty response', async () => {
    stubFetch(null, 204);

    await client().cancelPayoutLink('link-1');

    expect(captured[0]?.url).toBe(`${BASE}/payout-links/link-1/cancel`);
    expect(captured[0]?.method).toBe('POST');
  });
});

describe('expenses', () => {
  test('list passes the date range and maps spent_amount plus receipt IDs', async () => {
    stubFetch([
      {
        id: 'exp-1',
        state: 'approved',
        expense_date: '2026-08-14T09:30:00Z',
        spent_amount: { amount: 42.5, currency: 'EUR' },
        merchant: { name: 'Coffee Bar' },
        splits: [{ amount: { amount: 42.5, currency: 'EUR' }, category: { name: 'Meals' } }],
        transaction_id: 'tx-9',
        receipt_ids: ['rec-1', 'rec-2'],
      },
    ]);

    const expenses = await client().listExpenses({ from: '2026-08-01', to: '2026-08-31', count: 50 });

    expect(captured[0]?.url).toBe(`${BASE}/expenses?from=2026-08-01&to=2026-08-31&count=50`);
    expect(expenses[0]?.amount).toBe(42.5);
    expect(expenses[0]?.currency).toBe('EUR');
    expect(expenses[0]?.category).toBe('Meals');
    expect(expenses[0]?.merchant).toBe('Coffee Bar');
    expect(expenses[0]?.receiptIds).toEqual(['rec-1', 'rec-2']);
  });

  test('list accepts an enveloped response and defaults a missing receipt list', async () => {
    stubFetch({ expenses: [{ id: 'exp-2', state: 'awaiting_review' }] });

    const expenses = await client().listExpenses();

    expect(captured[0]?.url).toBe(`${BASE}/expenses`);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.receiptIds).toEqual([]);
    expect(expenses[0]?.amount).toBeUndefined();
  });

  test('list unwraps a bare numeric amount and a string merchant', async () => {
    stubFetch([{ id: 'exp-3', state: 'approved', amount: 12, currency: 'GBP', merchant: 'Taxi Co' }]);

    const expenses = await client().listExpenses();

    expect(expenses[0]?.amount).toBe(12);
    expect(expenses[0]?.currency).toBe('GBP');
    expect(expenses[0]?.merchant).toBe('Taxi Co');
  });

  test('get builds the single-expense path and joins a split payer name', async () => {
    stubFetch({
      id: 'exp 4',
      state: 'approved',
      payer: { first_name: 'Ada', last_name: 'Lovelace' },
    });

    const expense = await client().getExpense('exp 4');

    expect(captured[0]?.url).toBe(`${BASE}/expenses/exp%204`);
    expect(expense.spender).toBe('Ada Lovelace');
  });

  test('list prefers spent_amount over a conflicting top-level amount', async () => {
    stubFetch([
      {
        id: 'exp-5',
        state: 'approved',
        spent_amount: { amount: 24.38, currency: 'GBP' },
        amount: { amount: 99, currency: 'EUR' },
      },
    ]);

    const expenses = await client().listExpenses();

    expect(expenses[0]?.amount).toBe(24.38);
    expect(expenses[0]?.currency).toBe('GBP');
  });
});

describe('receipts', () => {
  function stubBinary(body: Uint8Array, headers: Record<string, string>, status = 200): void {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured.push({ url: String(url), method: init.method ?? 'GET', body: undefined });
      const payload: BodyInit = status === 200 ? (body.buffer as ArrayBuffer) : 'nope';
      return new Response(payload, { status, headers });
    }) as unknown as typeof fetch;
  }

  test('downloads the file and names it from the content type', async () => {
    stubBinary(new Uint8Array([1, 2, 3]), { 'Content-Type': 'application/pdf' });

    const receipt = await client().getReceipt('exp-1', 'rec-1');

    expect(captured[0]?.url).toBe(`${BASE}/expenses/exp-1/receipts/rec-1/content`);
    expect(receipt.filename).toBe('rec-1.pdf');
    expect(receipt.data).toEqual(Buffer.from([1, 2, 3]));
  });

  test('prefers the name in Content-Disposition', async () => {
    stubBinary(new Uint8Array([0]), {
      'Content-Type': 'image/jpeg',
      'Content-Disposition': 'attachment; filename="August lunch.jpg"',
    });

    const receipt = await client().getReceipt('exp-1', 'rec-1');

    expect(receipt.filename).toBe('August lunch.jpg');
  });

  test('decodes an RFC 5987 name and strips any directory component', async () => {
    stubBinary(new Uint8Array([0]), {
      'Content-Type': 'application/pdf',
      'Content-Disposition': "attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd",
    });

    const receipt = await client().getReceipt('exp-1', 'rec-1');

    expect(receipt.filename).toBe('passwd');
  });

  test('falls back to .bin for an unknown content type', async () => {
    stubBinary(new Uint8Array([0]), { 'Content-Type': 'application/octet-stream' });

    const receipt = await client().getReceipt('exp-1', 'rec-1');

    expect(receipt.filename).toBe('rec-1.bin');
  });

  test('a 403 explains the missing expenses permission', async () => {
    stubBinary(new Uint8Array([0]), {}, 403);

    await expect(client().getReceipt('exp-1', 'rec-1')).rejects.toThrow(/Revolut API error \(403\)/);
  });
});
