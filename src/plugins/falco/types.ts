/**
 * Falco (Horus Software) — the internal API the Electron desktop app uses, not
 * the Partner API. Three hosts: accounts for auth, api.my-falco.be for Peppol
 * and invoices, and a separate billing host for outbound sales documents.
 */
export const AUTH_URL = 'https://accounts.horus-software.be';
export const API_URL = 'https://api.my-falco.be';
export const BILLING_API_URL = 'https://horusapi-billing.azurewebsites.net';
export const BRAND = 'falco';

/** Login asks for four scopes; the refresh exchange only ever returns three. */
export const LOGIN_SCOPES = ['myhorus', 'billing', 'falco', 'oclaf'];
export const REFRESH_SCOPES = ['myhorus', 'billing', 'oclaf'];

/**
 * One Falco login scoped to one organization. A Falco account can hold several
 * organizations and every data endpoint is org-scoped, so the organization is
 * part of the credentials rather than a separate switch.
 */
export interface FalcoCredentials {
  /** Rotated on every refresh; the only long-lived secret. */
  refreshToken: string;
  /** Unix ms — when the refresh token itself dies, not the access token. */
  refreshExpiryDate: number;
  accessToken?: string;
  /** Unix ms. */
  expiryDate?: number;
  /**
   * The organization this profile acts on. Note the access token is scoped to
   * the ACCOUNT, not to this organization: it is only a path parameter on each
   * request. A holder of these credentials can reach every organization on the
   * account, and profile read-only is enforced by the CLI, not by Falco.
   */
  organizationId: string;
  organizationName?: string;
  userId: string;
  userEmail: string;
}

export interface FalcoOrganization {
  id: string;
  name: string;
  vatNumber?: string | null;
  country?: string | null;
  mainProductCode?: string | null;
}

export interface FalcoUserMe {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  language: string;
  organizations: FalcoOrganization[];
}

export interface PeppolDocumentFilters {
  showNotImported?: boolean;
  showImported?: boolean;
  showProcessing?: boolean;
  showAccepted?: boolean;
  showRejected?: boolean;
  showNoResponse?: boolean;
  minDate?: string;
  maxDate?: string;
  selfBilling?: boolean;
  /** Cursor: the last id seen on the previous page. */
  last?: string;
}

export interface PeppolDocument {
  id: string;
  companyName: string | null;
  documentNumber: string | null;
  creationDate: string | null;
  documentDate: string | null;
  dueDate: string | null;
  downloadDate: string | null;
  amount: string | null;
  currency: string | null;
  supplierVatNumber: string | null;
  supplierParticipant: string | null;
  supplierName: string | null;
  isCreditNote: boolean;
  invoiceReference: string | null;
  paymentReference: string | null;
  bankAccountNumber: string | null;
  doNotImport: boolean;
  importState: string | null;
  importDate: string | null;
  fiduciaryDocumentId: string | null;
  lastInvoiceResponse: unknown;
  /** Bookkeeping flag on the Peppol inbox row itself (Paid / NotPaid). */
  paymentStatus: string | null;
  comment: string | null;
  documentType: string | null;
}

export type BillingDocumentType =
  | 'Invoice'
  | 'CreditNote'
  | 'Estimate'
  | 'Proforma'
  | 'AdvancePayment'
  | (string & {});

export interface BillingDocument {
  Id: string;
  Type: BillingDocumentType;
  DocumentNumber: number | null;
  CreationDate: string | null;
  SendDate: string | null;
  DueDate: string | null;
  CustomerId: string | null;
  CustomerName: string | null;
  ReceiverEmailAddress: string | null;
  ReceiverVatNumber: string | null;
  IntermediateAmount: string | null;
  FinalAmount: string | null;
  CurrencyCode: string | null;
  Status: string | null;
  PeppolStatus: string | null;
  PaymentStatus: string | null;
  Communication: string | null;
  CommunicationType: string | null;
  HasPdfError: boolean;
}

export interface ListBillingDocumentsFilters {
  Invoices?: boolean;
  CreditNotes?: boolean;
  Estimates?: boolean;
  AdvancePayments?: boolean;
  Proformas?: boolean;
  Offset?: number;
  StartingDate?: Date;
  EndDate?: Date;
}

export interface InvoiceFile {
  id: string;
  fileName: string;
  contentType: string;
  order: number;
  fileSize: number;
}

export interface Invoice {
  id: string;
  peppolInvoiceId: string | null;
  type: 'PurchaseInvoice' | 'PurchaseCreditNote' | 'SaleInvoice' | 'SaleCreditNote' | (string & {});
  status: string | null;
  paymentStatus: string | null;
  peppolStatus: string | null;
  origin: string | null;
  createdAt: string | null;
  invoiceDate: string | null;
  invoiceDueDate: string | null;
  amount: string | null;
  invoiceCurrency: string | null;
  invoiceReference: string | null;
  paymentReference: string | null;
  bankAccountNumber: string | null;
  supplierId: string | null;
  supplierName: string | null;
  customerName: string | null;
  name: string | null;
  category: string | null;
  fiduciaryId: string | null;
  fiduciaryStatus: string | null;
  files: InvoiceFile[];
}

export type InvoicePaymentStatus = 'Paid' | 'NotPaid';

/** Raw bytes plus the content type the server reported. */
export interface BinaryPayload {
  contentType: string;
  bytes: Uint8Array;
}
