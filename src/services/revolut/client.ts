import { CliError, httpStatusToErrorCode } from '../../utils/errors';
import { apiBaseUrl } from '../../types/revolut';
import type { ServiceClient, ValidationResult } from '../../types/service';
import type {
  RevolutAccount,
  RevolutCounterparty,
  RevolutCounterpartyCreateOptions,
  RevolutCredentials,
  RevolutTransaction,
  RevolutTransactionListOptions,
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
}
