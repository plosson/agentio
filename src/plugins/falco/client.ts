import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError, httpStatusToErrorCode } from '../../utils/errors';
import {
  API_URL,
  BILLING_API_URL,
  type BillingDocument,
  type BinaryPayload,
  type FalcoCredentials,
  type FalcoUserMe,
  type Invoice,
  type InvoicePaymentStatus,
  type ListBillingDocumentsFilters,
  type PeppolDocument,
  type PeppolDocumentFilters,
} from './types';

/** The desktop app requests every state; narrowing happens client-side. */
const PEPPOL_LIST_DEFAULTS = {
  showNotImported: true,
  showImported: true,
  showProcessing: true,
  showAccepted: true,
  showRejected: true,
  showNoResponse: true,
  selfBilling: false,
};

/** Both list endpoints are cursor-paginated; stop long before an infinite walk. */
const MAX_PAGES = 500;

export type PageProgress = (page: number, newItems: number, totalSoFar: number) => void;

export class FalcoClient implements ServiceClient {
  private readonly accessToken: string;
  private readonly organizationId: string;

  constructor(credentials: FalcoCredentials) {
    // The host refreshes before handing credentials over, so an access token is
    // present in practice; an empty one simply fails the first call as 401.
    this.accessToken = credentials.accessToken ?? '';
    this.organizationId = credentials.organizationId;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const me = await this.getUserMe();
      const org = me.organizations.find((o) => o.id === this.organizationId);
      return { valid: true, info: `${me.email} — ${org?.name ?? this.organizationId}` };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, Accept: 'application/json', ...extra };
  }

  private async send(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      throw new CliError(
        'NETWORK_ERROR',
        `Could not reach Falco while ${what}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private fail(status: number, body: string, what: string): never {
    throw new CliError(
      httpStatusToErrorCode(status),
      `Falco request failed while ${what} (HTTP ${status})`,
      body.trim() ? body.slice(0, 200) : undefined,
    );
  }

  private async getJson<T>(pathAndQuery: string, what: string): Promise<T> {
    const response = await this.send(API_URL + pathAndQuery, { headers: this.headers() }, what);
    const text = await response.text();
    if (!response.ok) this.fail(response.status, text, what);
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError('API_ERROR', `Falco returned malformed JSON while ${what}`, text.slice(0, 200));
    }
  }

  private async getBinary(pathAndQuery: string, accept: string, what: string): Promise<BinaryPayload> {
    const response = await this.send(
      API_URL + pathAndQuery,
      { headers: this.headers({ Accept: accept }) },
      what,
    );
    if (!response.ok) this.fail(response.status, await response.text().catch(() => ''), what);
    return {
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }

  // --- User -----------------------------------------------------------------

  getUserMe(): Promise<FalcoUserMe> {
    return this.getJson<FalcoUserMe>('/user/me', 'reading the account');
  }

  // --- Peppol inbox ---------------------------------------------------------

  listPeppolDocuments(filters: PeppolDocumentFilters = {}): Promise<PeppolDocument[]> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...PEPPOL_LIST_DEFAULTS, ...filters })) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return this.getJson<PeppolDocument[]>(
      `/peppol/documents/${this.organizationId}?${query.toString()}`,
      'listing Peppol documents',
    );
  }

  /** Walk the `last=<id>` cursor until the server stops returning new documents. */
  async listAllPeppolDocuments(
    filters: Omit<PeppolDocumentFilters, 'last'> = {},
    onPage?: PageProgress,
  ): Promise<PeppolDocument[]> {
    const all: PeppolDocument[] = [];
    const seen = new Set<string>();
    let last: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const chunk = await this.listPeppolDocuments({ ...filters, last });
      if (chunk.length === 0) break;

      let added = 0;
      for (const document of chunk) {
        if (seen.has(document.id)) continue;
        seen.add(document.id);
        all.push(document);
        added += 1;
      }
      onPage?.(page, added, all.length);
      // A page of documents we have already seen means the cursor is not advancing.
      if (added === 0) break;

      const oldest = chunk[chunk.length - 1];
      if (!oldest) break;
      last = oldest.id;
    }
    return all;
  }

  /** The raw UBL XML for one Peppol document. */
  downloadPeppolDocumentUbl(documentId: string): Promise<BinaryPayload> {
    return this.getBinary(`/peppol/document/${documentId}`, 'application/xml', `downloading document ${documentId}`);
  }

  // --- Invoices (the payment-status view) -----------------------------------

  listInvoices(
    filters: { take?: number; sortBy?: string; sortDirection?: 'asc' | 'desc'; last?: string } = {},
  ): Promise<Invoice[]> {
    const query = new URLSearchParams({ organizationId: this.organizationId });
    query.set('take', String(filters.take ?? 200));
    query.set('sortBy', filters.sortBy ?? 'createdAt');
    query.set('sortDirection', filters.sortDirection ?? 'desc');
    if (filters.last) query.set('last', filters.last);
    return this.getJson<Invoice[]>(`/document/invoices?${query.toString()}`, 'listing invoices');
  }

  async listAllInvoices(onPage?: PageProgress): Promise<Invoice[]> {
    const all: Invoice[] = [];
    const seen = new Set<string>();
    let last: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const chunk = await this.listInvoices({ take: 100, last });
      if (chunk.length === 0) break;

      let added = 0;
      for (const invoice of chunk) {
        if (seen.has(invoice.id)) continue;
        seen.add(invoice.id);
        all.push(invoice);
        added += 1;
      }
      onPage?.(page, added, all.length);
      if (added === 0) break;

      const oldest = chunk[chunk.length - 1];
      if (!oldest) break;
      last = oldest.id;
    }
    return all;
  }

  /**
   * Flip the payment flag. `documentId` is the invoice id from listInvoices,
   * not the Peppol document id.
   */
  async setInvoicePaymentStatus(documentId: string, status: InvoicePaymentStatus): Promise<void> {
    const what = `updating payment status for ${documentId}`;
    const response = await this.send(
      `${API_URL}/document/invoices/status`,
      {
        method: 'PUT',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ DocumentId: documentId, PaymentStatus: status }),
      },
      what,
    );
    if (!response.ok) this.fail(response.status, await response.text().catch(() => ''), what);
  }

  // --- Billing (outbound sales documents, a separate host) ------------------

  private async billing(method: 'GET' | 'POST', path: string, body: unknown, what: string): Promise<Response> {
    const headers = this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : {});
    return this.send(
      BILLING_API_URL + path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      what,
    );
  }

  async listBillingDocuments(
    filters: ListBillingDocumentsFilters = { Invoices: true, CreditNotes: true },
  ): Promise<BillingDocument[]> {
    const what = 'listing billing documents';
    const body: Record<string, unknown> = {
      Invoices: !!filters.Invoices,
      CreditNotes: !!filters.CreditNotes,
      Estimates: !!filters.Estimates,
      AdvancePayments: !!filters.AdvancePayments,
      Proformas: !!filters.Proformas,
      Offset: filters.Offset ?? 0,
    };
    // The billing host takes a date as three separate numbers, not an ISO string.
    if (filters.StartingDate) {
      body.StartingDateDay = filters.StartingDate.getUTCDate();
      body.StartingDateMonth = filters.StartingDate.getUTCMonth() + 1;
      body.StartingDateYear = filters.StartingDate.getUTCFullYear();
    }
    if (filters.EndDate) {
      body.EndDateDay = filters.EndDate.getUTCDate();
      body.EndDateMonth = filters.EndDate.getUTCMonth() + 1;
      body.EndDateYear = filters.EndDate.getUTCFullYear();
    }

    const response = await this.billing(
      'POST',
      `/api.billing/billing-documents/period/${encodeURIComponent(this.organizationId)}`,
      body,
      what,
    );
    const text = await response.text();
    if (!response.ok) this.fail(response.status, text, what);
    try {
      return (JSON.parse(text) as { BillingDocuments?: BillingDocument[] }).BillingDocuments ?? [];
    } catch {
      throw new CliError('API_ERROR', `Falco returned malformed JSON while ${what}`, text.slice(0, 200));
    }
  }

  async downloadBillingDocumentPdf(documentId: string): Promise<BinaryPayload> {
    const what = `downloading billing document ${documentId}`;
    const response = await this.billing(
      'GET',
      `/api.billing/billing-documents/src/${encodeURIComponent(documentId)}`,
      undefined,
      what,
    );
    if (!response.ok) this.fail(response.status, await response.text().catch(() => ''), what);
    return {
      contentType: response.headers.get('content-type') ?? 'application/pdf',
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  }
}
