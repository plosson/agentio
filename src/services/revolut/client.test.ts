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
