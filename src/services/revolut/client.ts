import { CliError, httpStatusToErrorCode } from '../../utils/errors';
import { apiBaseUrl } from '../../types/revolut';
import type { ServiceClient, ValidationResult } from '../../types/service';
import type {
  RevolutAccount,
  RevolutCounterparty,
  RevolutCounterpartyCreateOptions,
  RevolutCredentials,
  RevolutDraftPayment,
  RevolutExpense,
  RevolutExpenseListOptions,
  RevolutPaymentDraft,
  RevolutPaymentDraftCreateOptions,
  RevolutPaymentDraftSummary,
  RevolutPayoutLink,
  RevolutPayoutLinkListOptions,
  RevolutPayoutMethod,
  RevolutReceipt,
  RevolutTransaction,
  RevolutTransactionListOptions,
  RevolutTransferOptions,
  RevolutTransferResult,
} from '../../types/revolut';

interface RawAccount {
  id: string;
  name?: string;
  balance: number;
  currency: string;
  state: string;
  public: boolean;
  created_at: string;
  updated_at: string;
}

interface RawLeg {
  leg_id: string;
  account_id: string;
  amount: number;
  currency: string;
  bill_amount?: number;
  bill_currency?: string;
  description?: string;
  balance?: number;
  counterparty?: { id?: string; account_id?: string; type?: string };
}

interface RawTransaction {
  id: string;
  type: string;
  state: string;
  request_id?: string;
  reference?: string;
  reason_code?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  legs?: RawLeg[];
  merchant?: { name?: string; city?: string; category_code?: string; country?: string };
  card?: { first_name?: string; last_name?: string };
}

interface RawExpense {
  id: string;
  state: string;
  expense_date?: string;
  completed_at?: string;
  /** Docs use spent_amount; keep amount as a legacy/fallback shape. */
  spent_amount?: RawAmount;
  amount?: number | RawAmount;
  currency?: string;
  description?: string;
  category?: string;
  merchant?: string | { name?: string };
  transaction_id?: string;
  /** Business API field is `payer`; older drafts used `spender`. */
  payer?: string | { name?: string; first_name?: string; last_name?: string };
  spender?: string | { name?: string; first_name?: string; last_name?: string };
  receipt_ids?: string[];
  splits?: Array<{
    amount?: RawAmount;
    category?: { id?: string; name?: string; code?: string };
  }>;
}

interface RawCounterpartyAccount {
  id?: string;
  name?: string;
  bank_country?: string;
  currency?: string;
  type?: string;
  account_no?: string;
  iban?: string;
  sort_code?: string;
  routing_number?: string;
  bic?: string;
  recipient_charges?: string;
}

interface RawCounterparty {
  id: string;
  name: string;
  phone?: string;
  profile_type?: string;
  country?: string;
  state: string;
  created_at: string;
  updated_at: string;
  accounts?: RawCounterpartyAccount[];
}

interface RawTransferResult {
  id: string;
  state: string;
  created_at: string;
  completed_at?: string;
}

interface RawAmount {
  amount?: number;
  currency?: string;
}

interface RawReceiver {
  counterparty_id?: string;
  account_id?: string;
  card_id?: string;
}

interface RawDraftPayment {
  id: string;
  amount?: RawAmount;
  currency?: string;
  account_id: string;
  receiver?: RawReceiver;
  state: string;
  reason?: string;
  error_message?: string;
  reference?: string;
  transfer_reason_code?: string;
  current_charge_options?: {
    from?: RawAmount;
    to?: RawAmount;
    rate?: string;
    fee?: RawAmount;
  };
}

interface RawPaymentDraft {
  title?: string;
  scheduled_for?: string;
  source?: string;
  payments?: RawDraftPayment[];
}

interface RawPaymentDraftSummary {
  id: string;
  title?: string;
  scheduled_for?: string;
  payments_count: number;
  source?: string;
}

interface RawPayoutLink {
  id: string;
  state: string;
  created_at: string;
  updated_at: string;
  counterparty_name: string;
  save_counterparty?: boolean;
  request_id: string;
  expiry_date?: string;
  payout_methods?: RevolutPayoutMethod[];
  account_id: string;
  amount: number;
  currency: string;
  url?: string;
  reference: string;
  transfer_reason_code?: string;
  counterparty_id?: string;
  transaction_id?: string;
  cancellation_reason?: string;
}

function mapAccount(raw: RawAccount): RevolutAccount {
  return {
    id: raw.id,
    name: raw.name,
    balance: raw.balance,
    currency: raw.currency,
    state: raw.state,
    public: raw.public,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function mapTransaction(raw: RawTransaction): RevolutTransaction {
  const cardHolder = [raw.card?.first_name, raw.card?.last_name].filter(Boolean).join(' ');

  return {
    id: raw.id,
    type: raw.type,
    state: raw.state,
    requestId: raw.request_id,
    reference: raw.reference,
    reasonCode: raw.reason_code,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    completedAt: raw.completed_at,
    merchant: raw.merchant
      ? {
          name: raw.merchant.name,
          city: raw.merchant.city,
          categoryCode: raw.merchant.category_code,
          country: raw.merchant.country,
        }
      : undefined,
    cardHolder: cardHolder || undefined,
    legs: (raw.legs ?? []).map((leg) => ({
      legId: leg.leg_id,
      accountId: leg.account_id,
      amount: leg.amount,
      currency: leg.currency,
      billAmount: leg.bill_amount,
      billCurrency: leg.bill_currency,
      description: leg.description,
      balance: leg.balance,
      counterpartyId: leg.counterparty?.id,
      counterpartyAccountId: leg.counterparty?.account_id,
      counterpartyType: leg.counterparty?.type,
    })),
  };
}

function personName(value: RawExpense['spender']): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (!value) return undefined;
  const full = value.name || [value.first_name, value.last_name].filter(Boolean).join(' ');
  return full || undefined;
}

function mapExpense(raw: RawExpense): RevolutExpense {
  // Revolut Business returns money under `spent_amount` ({amount, currency}).
  // Older drafts / fixtures used a top-level `amount` that was either a bare
  // number or the same wrapper, so keep those as fallbacks.
  const money =
    raw.spent_amount ??
    (typeof raw.amount === 'object' && raw.amount !== null ? raw.amount : undefined);
  const amount = money?.amount ?? (typeof raw.amount === 'number' ? raw.amount : undefined);
  const category =
    raw.category ??
    raw.splits?.map((split) => split.category?.name).find((name): name is string => Boolean(name));

  return {
    id: raw.id,
    state: raw.state,
    expenseDate: raw.expense_date,
    completedAt: raw.completed_at,
    amount: typeof amount === 'number' ? amount : undefined,
    currency: money?.currency ?? raw.currency,
    description: raw.description,
    category,
    merchant: typeof raw.merchant === 'string' ? raw.merchant || undefined : raw.merchant?.name,
    transactionId: raw.transaction_id,
    spender: personName(raw.payer ?? raw.spender),
    receiptIds: raw.receipt_ids ?? [],
  };
}

function mapCounterparty(raw: RawCounterparty): RevolutCounterparty {
  return {
    id: raw.id,
    name: raw.name,
    phone: raw.phone,
    profileType: raw.profile_type,
    country: raw.country,
    state: raw.state,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    accounts: (raw.accounts ?? []).map((account) => ({
      id: account.id,
      name: account.name,
      bankCountry: account.bank_country,
      currency: account.currency,
      type: account.type,
      accountNo: account.account_no,
      iban: account.iban,
      sortCode: account.sort_code,
      routingNumber: account.routing_number,
      bic: account.bic,
      recipientCharges: account.recipient_charges,
    })),
  };
}

function mapTransferResult(raw: RawTransferResult): RevolutTransferResult {
  return {
    id: raw.id,
    state: raw.state,
    createdAt: raw.created_at,
    completedAt: raw.completed_at,
  };
}

function mapDraftPayment(raw: RawDraftPayment): RevolutDraftPayment {
  const charge = raw.current_charge_options;

  return {
    id: raw.id,
    amount: raw.amount?.amount ?? 0,
    currency: raw.amount?.currency ?? raw.currency,
    accountId: raw.account_id,
    counterpartyId: raw.receiver?.counterparty_id,
    counterpartyAccountId: raw.receiver?.account_id,
    counterpartyCardId: raw.receiver?.card_id,
    state: raw.state,
    reason: raw.reason,
    errorMessage: raw.error_message,
    reference: raw.reference,
    transferReasonCode: raw.transfer_reason_code,
    charge: charge
      ? {
          fromAmount: charge.from?.amount,
          fromCurrency: charge.from?.currency,
          toAmount: charge.to?.amount,
          toCurrency: charge.to?.currency,
          rate: charge.rate,
          feeAmount: charge.fee?.amount,
          feeCurrency: charge.fee?.currency,
        }
      : undefined,
  };
}

function mapPayoutLink(raw: RawPayoutLink): RevolutPayoutLink {
  return {
    id: raw.id,
    state: raw.state,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    counterpartyName: raw.counterparty_name,
    saveCounterparty: raw.save_counterparty ?? false,
    requestId: raw.request_id,
    expiryDate: raw.expiry_date,
    payoutMethods: raw.payout_methods ?? [],
    accountId: raw.account_id,
    amount: raw.amount,
    currency: raw.currency,
    url: raw.url,
    reference: raw.reference,
    transferReasonCode: raw.transfer_reason_code,
    counterpartyId: raw.counterparty_id,
    transactionId: raw.transaction_id,
    cancellationReason: raw.cancellation_reason,
  };
}

const RECEIPT_EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/tiff': '.tiff',
};

/** Strip any directory component so a crafted header cannot escape the output dir. */
function basename(name: string): string {
  const tail = name.split(/[\\/]/).pop() ?? '';
  return tail === '.' || tail === '..' ? '' : tail;
}

function filenameFromDisposition(disposition: string | undefined): string | undefined {
  if (!disposition) return undefined;

  // RFC 5987 form wins when present: filename*=UTF-8''receipt%20jan.pdf
  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      const name = basename(decodeURIComponent(encoded[1].trim()));
      if (name) return name;
    } catch {
      // Malformed percent-encoding: fall through to the plain form.
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  const name = plain?.[1] ? basename(plain[1].trim()) : '';
  return name || undefined;
}

/**
 * Revolut does not promise a file name, so fall back to the receipt ID with an
 * extension guessed from the content type. `.bin` keeps an unknown type honest
 * rather than mislabelling it as a PDF.
 */
function receiptFilename(receiptId: string, contentType?: string, disposition?: string): string {
  const provided = filenameFromDisposition(disposition);
  if (provided) return provided;

  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return `${receiptId}${RECEIPT_EXTENSIONS[type] ?? '.bin'}`;
}

function receiptErrorSuggestion(status: number): string | undefined {
  if (status === 401) return 'Run: agentio revolut profile add to re-authorise';
  if (status === 403) {
    return 'The Revolut API app needs read access to expenses; check its permissions in the Revolut Business app';
  }
  return undefined;
}

export class RevolutClient implements ServiceClient {
  private credentials: RevolutCredentials;
  private baseUrl: string;

  constructor(credentials: RevolutCredentials) {
    this.credentials = credentials;
    this.baseUrl = apiBaseUrl(credentials.environment);
  }

  async validate(): Promise<ValidationResult> {
    try {
      const accounts = await this.listAccounts();
      const currencies = [...new Set(accounts.map((a) => a.currency))].sort();
      const summary = currencies.length > 0 ? currencies.join(', ') : 'no accounts';
      return { valid: true, info: `${this.credentials.environment} - ${accounts.length} account(s): ${summary}` };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      Accept: 'application/json',
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new CliError('NETWORK_ERROR', `Could not reach the Revolut API: ${message}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new CliError(
        httpStatusToErrorCode(response.status),
        `Revolut API error (${response.status}): ${text}`,
        response.status === 401 ? 'Run: agentio revolut profile add to re-authorise' : undefined,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async requestBinary(
    path: string,
  ): Promise<{ buffer: Buffer; contentType?: string; disposition?: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          Accept: '*/*',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new CliError('NETWORK_ERROR', `Could not reach the Revolut API: ${message}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new CliError(
        httpStatusToErrorCode(response.status),
        `Revolut API error (${response.status}): ${text}`,
        receiptErrorSuggestion(response.status),
      );
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? undefined,
      disposition: response.headers.get('content-disposition') ?? undefined,
    };
  }

  async listAccounts(): Promise<RevolutAccount[]> {
    const raw = await this.request<RawAccount[]>('GET', '/accounts');
    return raw.map(mapAccount);
  }

  async listTransactions(options: RevolutTransactionListOptions = {}): Promise<RevolutTransaction[]> {
    const params = new URLSearchParams();
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    if (options.counterpartyId) params.set('counterparty', options.counterpartyId);
    if (options.accountId) params.set('account', options.accountId);
    if (options.type) params.set('type', options.type);
    if (options.count !== undefined) params.set('count', String(options.count));

    const query = params.toString();
    const raw = await this.request<RawTransaction[]>('GET', `/transactions${query ? `?${query}` : ''}`);
    return raw.map(mapTransaction);
  }

  async getTransaction(id: string): Promise<RevolutTransaction> {
    const raw = await this.request<RawTransaction>('GET', `/transaction/${encodeURIComponent(id)}`);
    return mapTransaction(raw);
  }

  async listCounterparties(): Promise<RevolutCounterparty[]> {
    const raw = await this.request<RawCounterparty[]>('GET', '/counterparties');
    return raw.map(mapCounterparty);
  }

  async getCounterparty(id: string): Promise<RevolutCounterparty> {
    const raw = await this.request<RawCounterparty>('GET', `/counterparty/${encodeURIComponent(id)}`);
    return mapCounterparty(raw);
  }

  async createCounterparty(options: RevolutCounterpartyCreateOptions): Promise<RevolutCounterparty> {
    const body: Record<string, unknown> = {
      bank_country: options.bankCountry,
      currency: options.currency,
    };

    if (options.companyName) {
      body.company_name = options.companyName;
    } else {
      body.individual_name = {
        first_name: options.individualFirstName,
        last_name: options.individualLastName,
      };
    }

    if (options.iban) body.iban = options.iban;
    if (options.bic) body.bic = options.bic;
    if (options.accountNo) body.account_no = options.accountNo;
    if (options.sortCode) body.sort_code = options.sortCode;
    if (options.routingNumber) body.routing_number = options.routingNumber;
    if (options.email) body.email = options.email;
    if (options.phone) body.phone = options.phone;

    const raw = await this.request<RawCounterparty>('POST', '/counterparty', body);
    return mapCounterparty(raw);
  }

  async deleteCounterparty(id: string): Promise<void> {
    await this.request<void>('DELETE', `/counterparty/${encodeURIComponent(id)}`);
  }

  /** Move money between two of the business's own accounts, same currency only. */
  async createTransfer(options: RevolutTransferOptions): Promise<RevolutTransferResult> {
    const body: Record<string, unknown> = {
      request_id: options.requestId,
      source_account_id: options.sourceAccountId,
      target_account_id: options.targetAccountId,
      amount: options.amount,
      currency: options.currency,
    };

    if (options.reference) body.reference = options.reference;

    const raw = await this.request<RawTransferResult>('POST', '/transfer', body);
    return mapTransferResult(raw);
  }

  /**
   * Create a payment draft. Nothing moves until someone sends it for processing
   * in the Revolut Business app, which is also where scheduled payments live.
   * Returns the draft ID.
   */
  async createPaymentDraft(options: RevolutPaymentDraftCreateOptions): Promise<string> {
    const receiver: Record<string, unknown> = { counterparty_id: options.counterpartyId };
    if (options.counterpartyAccountId) receiver.account_id = options.counterpartyAccountId;
    if (options.counterpartyCardId) receiver.card_id = options.counterpartyCardId;

    const payment: Record<string, unknown> = {
      account_id: options.accountId,
      receiver,
      amount: options.amount,
      currency: options.currency,
      reference: options.reference,
    };

    if (options.chargeBearer) payment.charge_bearer = options.chargeBearer;
    if (options.transferReasonCode) payment.transfer_reason_code = options.transferReasonCode;

    const body: Record<string, unknown> = { payments: [payment] };
    if (options.title) body.title = options.title;
    if (options.scheduleFor) body.schedule_for = options.scheduleFor;

    const raw = await this.request<{ id: string }>('POST', '/payment-drafts', body);
    return raw.id;
  }

  async listPaymentDrafts(source?: string): Promise<RevolutPaymentDraftSummary[]> {
    const query = source ? `?source=${encodeURIComponent(source)}` : '';
    const raw = await this.request<{ payment_orders?: RawPaymentDraftSummary[] }>(
      'GET',
      `/payment-drafts${query}`,
    );

    return (raw.payment_orders ?? []).map((order) => ({
      id: order.id,
      title: order.title,
      scheduledFor: order.scheduled_for,
      paymentsCount: order.payments_count,
      source: order.source,
    }));
  }

  async getPaymentDraft(id: string): Promise<RevolutPaymentDraft> {
    const raw = await this.request<RawPaymentDraft>('GET', `/payment-drafts/${encodeURIComponent(id)}`);

    return {
      title: raw.title,
      scheduledFor: raw.scheduled_for,
      source: raw.source,
      payments: (raw.payments ?? []).map(mapDraftPayment),
    };
  }

  async deletePaymentDraft(id: string): Promise<void> {
    await this.request<void>('DELETE', `/payment-drafts/${encodeURIComponent(id)}`);
  }

  async listPayoutLinks(options: RevolutPayoutLinkListOptions = {}): Promise<RevolutPayoutLink[]> {
    const params = new URLSearchParams();
    if (options.createdBefore) params.set('created_before', options.createdBefore);
    if (options.limit !== undefined) params.set('limit', String(options.limit));

    const query = params.toString();
    const raw = await this.request<RawPayoutLink[]>('GET', `/payout-links${query ? `?${query}` : ''}`);
    return raw.map(mapPayoutLink);
  }

  async getPayoutLink(id: string): Promise<RevolutPayoutLink> {
    const raw = await this.request<RawPayoutLink>('GET', `/payout-links/${encodeURIComponent(id)}`);
    return mapPayoutLink(raw);
  }

  /** Only links that have not been claimed yet can be cancelled. */
  async cancelPayoutLink(id: string): Promise<void> {
    await this.request<void>('POST', `/payout-links/${encodeURIComponent(id)}/cancel`);
  }

  /**
   * Expenses are paginated on time, not page number: narrow with `from`/`to`
   * and walk backwards. Revolut caps one response at 500 rows.
   */
  async listExpenses(options: RevolutExpenseListOptions = {}): Promise<RevolutExpense[]> {
    const params = new URLSearchParams();
    if (options.from) params.set('from', options.from);
    if (options.to) params.set('to', options.to);
    if (options.count !== undefined) params.set('count', String(options.count));

    const query = params.toString();
    const raw = await this.request<RawExpense[] | { expenses?: RawExpense[] }>(
      'GET',
      `/expenses${query ? `?${query}` : ''}`,
    );

    // Revolut's reference does not pin the envelope, and sibling endpoints here
    // differ (/transactions is a bare array, /payment-drafts wraps), so accept
    // either rather than guess.
    const rows = Array.isArray(raw) ? raw : (raw.expenses ?? []);
    return rows.map(mapExpense);
  }

  async getExpense(id: string): Promise<RevolutExpense> {
    const raw = await this.request<RawExpense>('GET', `/expenses/${encodeURIComponent(id)}`);
    return mapExpense(raw);
  }

  /**
   * Receipts come back as the file itself (PDF or image), not JSON, so this
   * bypasses `request()` and its JSON parse. Receipt IDs live on the expense.
   */
  async getReceipt(expenseId: string, receiptId: string): Promise<RevolutReceipt> {
    // Docs: GET /expenses/{expense_id}/receipts/{receipt_id}/content
    const path = `/expenses/${encodeURIComponent(expenseId)}/receipts/${encodeURIComponent(receiptId)}/content`;
    const { buffer, contentType, disposition } = await this.requestBinary(path);

    return {
      expenseId,
      receiptId,
      filename: receiptFilename(receiptId, contentType, disposition),
      contentType,
      data: buffer,
    };
  }
}
