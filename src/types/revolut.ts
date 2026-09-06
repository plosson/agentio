export type RevolutEnvironment = 'production' | 'sandbox';

const API_BASE: Record<RevolutEnvironment, string> = {
  production: 'https://b2b.revolut.com/api/1.0',
  sandbox: 'https://sandbox-b2b.revolut.com/api/1.0',
};

export function apiBaseUrl(environment: RevolutEnvironment): string {
  return API_BASE[environment];
}

export interface RevolutCredentials {
  environment: RevolutEnvironment;
  clientId: string;
  /** PEM-encoded private key matching the certificate uploaded to Revolut. */
  privateKey: string;
  /** Registered OAuth redirect URI; its host is the JWT `iss` claim. */
  redirectUri: string;
  accessToken: string;
  /** Long-lived; only ever returned by the initial authorisation code exchange. */
  refreshToken: string;
  /** Unix ms. Access tokens live 40 minutes. */
  expiryDate: number;
}

export interface RevolutAccount {
  id: string;
  name?: string;
  balance: number;
  currency: string;
  state: string;
  public: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RevolutMerchant {
  name?: string;
  city?: string;
  categoryCode?: string;
  country?: string;
}

export interface RevolutTransactionLeg {
  legId: string;
  accountId: string;
  amount: number;
  currency: string;
  billAmount?: number;
  billCurrency?: string;
  description?: string;
  balance?: number;
  counterpartyId?: string;
  counterpartyAccountId?: string;
  counterpartyType?: string;
}

export interface RevolutTransaction {
  id: string;
  type: string;
  state: string;
  requestId?: string;
  reference?: string;
  reasonCode?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  legs: RevolutTransactionLeg[];
  merchant?: RevolutMerchant;
  cardHolder?: string;
}

export interface RevolutTransactionListOptions {
  from?: string;
  to?: string;
  counterpartyId?: string;
  accountId?: string;
  type?: string;
  count?: number;
}

export interface RevolutCounterpartyAccount {
  id?: string;
  name?: string;
  bankCountry?: string;
  currency?: string;
  type?: string;
  accountNo?: string;
  iban?: string;
  sortCode?: string;
  routingNumber?: string;
  bic?: string;
  recipientCharges?: string;
}

export interface RevolutCounterparty {
  id: string;
  name: string;
  phone?: string;
  profileType?: string;
  country?: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  accounts: RevolutCounterpartyAccount[];
}

export interface RevolutCounterpartyCreateOptions {
  companyName?: string;
  individualFirstName?: string;
  individualLastName?: string;
  bankCountry: string;
  currency: string;
  iban?: string;
  bic?: string;
  accountNo?: string;
  sortCode?: string;
  routingNumber?: string;
  email?: string;
  phone?: string;
}

/** Who pays the transaction route fees: `shared` is SHA, `debtor` is OUR. */
export type RevolutChargeBearer = 'shared' | 'debtor';

/** How a payout link recipient may claim the money. */
export type RevolutPayoutMethod = 'revolut' | 'bank_account' | 'card';

export interface RevolutTransferOptions {
  requestId: string;
  sourceAccountId: string;
  targetAccountId: string;
  amount: number;
  currency: string;
  reference?: string;
}

/** Shared response of POST /pay and POST /transfer. */
export interface RevolutTransferResult {
  id: string;
  state: string;
  createdAt: string;
  completedAt?: string;
}

export interface RevolutPaymentDraftCreateOptions {
  title?: string;
  /** YYYY-MM-DD. Drafts are the only way to schedule a payment for a later date. */
  scheduleFor?: string;
  accountId: string;
  counterpartyId: string;
  counterpartyAccountId?: string;
  counterpartyCardId?: string;
  amount: number;
  currency: string;
  reference: string;
  chargeBearer?: RevolutChargeBearer;
  transferReasonCode?: string;
}

/** One row of GET /payment-drafts; carries counts, not payment details. */
export interface RevolutPaymentDraftSummary {
  id: string;
  title?: string;
  scheduledFor?: string;
  paymentsCount: number;
  source?: string;
}

export interface RevolutDraftPaymentCharge {
  fromAmount?: number;
  fromCurrency?: string;
  toAmount?: number;
  toCurrency?: string;
  rate?: string;
  feeAmount?: number;
  feeCurrency?: string;
}

export interface RevolutDraftPayment {
  id: string;
  amount: number;
  currency?: string;
  accountId: string;
  counterpartyId?: string;
  counterpartyAccountId?: string;
  counterpartyCardId?: string;
  state: string;
  reason?: string;
  errorMessage?: string;
  reference?: string;
  transferReasonCode?: string;
  charge?: RevolutDraftPaymentCharge;
}

/** GET /payment-drafts/{id}. The draft ID is not echoed back by the API. */
export interface RevolutPaymentDraft {
  title?: string;
  scheduledFor?: string;
  source?: string;
  payments: RevolutDraftPayment[];
}

export interface RevolutPayoutLink {
  id: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  counterpartyName: string;
  saveCounterparty: boolean;
  requestId: string;
  expiryDate?: string;
  payoutMethods: RevolutPayoutMethod[];
  accountId: string;
  amount: number;
  currency: string;
  /** Only returned while the link is active. */
  url?: string;
  reference: string;
  transferReasonCode?: string;
  counterpartyId?: string;
  transactionId?: string;
  cancellationReason?: string;
}

export interface RevolutPayoutLinkListOptions {
  createdBefore?: string;
  limit?: number;
}
