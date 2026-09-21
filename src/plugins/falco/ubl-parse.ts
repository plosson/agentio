// Minimal UBL Invoice / CreditNote parser. Supports Peppol BIS Billing 3.0
// (urn:cen.eu:en16931:2017 / urn:fdc:peppol.eu:2017:poacc:billing:3.0).

import { XMLParser } from 'fast-xml-parser';

export type UblParty = {
  name: string | null;
  vat_number: string | null;
  company_number: string | null;
  address: {
    street: string | null;
    street2: string | null;
    city: string | null;
    zip: string | null;
    country: string | null;
  };
  contact: {
    name: string | null;
    phone: string | null;
    email: string | null;
  };
};

export type UblLine = {
  id: string;
  description: string;
  note: string | null;
  quantity: string;
  unit_code: string | null;
  unit_price: string;
  line_extension_amount: string; // base total excl. tax
  tax_percent: string | null;
  tax_category: string | null;
  currency: string | null;
};

export type UblTaxSubtotal = {
  taxable_amount: string;
  tax_amount: string;
  tax_percent: string | null;
  tax_category: string | null;
};

export type UblTotals = {
  line_extension_amount: string | null;
  tax_exclusive_amount: string | null;
  tax_inclusive_amount: string | null;
  prepaid_amount: string | null;
  payable_amount: string | null;
};

export type UblPayment = {
  iban: string | null;
  bic: string | null;
  holder_name: string | null;
  reference: string | null;
  reference_type: string | null; // 'structured' if ISO-11649
  means_code: string | null; // 30 = credit transfer, 58 = SEPA CT, etc.
};

export type UblInvoice = {
  kind: 'Invoice' | 'CreditNote';
  profile: string | null;
  customization: string | null;
  number: string;
  issue_date: string | null;
  due_date: string | null;
  currency: string;
  language: string | null;
  buyer_reference: string | null;
  note: string | null;
  seller: UblParty;
  buyer: UblParty;
  lines: UblLine[];
  tax_subtotals: UblTaxSubtotal[];
  totals: UblTotals;
  payment: UblPayment;
};

// ---- helpers -----------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  // Belgian invoices routinely carry accented names as numeric entities
  // (&#233;). Without this they reach the rendered PDF undecoded.
  htmlEntities: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) =>
    [
      'InvoiceLine',
      'CreditNoteLine',
      'TaxSubtotal',
      'PaymentMeans',
      'PartyIdentification',
      'AdditionalDocumentReference',
      'PartyTaxScheme',
    ].includes(name),
});

function textOf(node: unknown): string | null {
  if (node == null) return null;
  if (typeof node === 'string') return node.length ? node : null;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (typeof o['#text'] === 'string') return (o['#text'] as string).trim() || null;
    if (typeof o['#text'] === 'number') return String(o['#text']);
  }
  return null;
}

function numAttr(node: unknown, attr: string): string | null {
  if (node && typeof node === 'object') {
    const v = (node as Record<string, unknown>)[`@_${attr}`];
    if (typeof v === 'string' && v.length) return v;
  }
  return null;
}

function readParty(partyNode: unknown): UblParty {
  const p = (partyNode as Record<string, unknown>) ?? {};
  const legal = (p.PartyLegalEntity as Record<string, unknown>) ?? {};
  const postal = (p.PostalAddress as Record<string, unknown>) ?? {};
  const country = (postal.Country as Record<string, unknown>) ?? {};
  const taxSchemes = (p.PartyTaxScheme as Array<Record<string, unknown>>) ?? [];
  const contact = (p.Contact as Record<string, unknown>) ?? {};
  const partyName = ((p.PartyName as Record<string, unknown>) ?? {}).Name;

  let vat: string | null = null;
  for (const scheme of taxSchemes) {
    const schemeId = textOf(((scheme.TaxScheme as Record<string, unknown>) ?? {}).ID);
    const companyId = textOf(scheme.CompanyID);
    if (schemeId && schemeId.toUpperCase() === 'VAT' && companyId) {
      vat = companyId;
      break;
    }
    if (!vat && companyId) vat = companyId;
  }

  return {
    name: textOf(partyName) ?? textOf(legal.RegistrationName) ?? null,
    vat_number: vat,
    company_number: textOf(legal.CompanyID),
    address: {
      street: textOf(postal.StreetName),
      street2: textOf(postal.AdditionalStreetName),
      city: textOf(postal.CityName),
      zip: textOf(postal.PostalZone),
      country: textOf(country.IdentificationCode),
    },
    contact: {
      name: textOf(contact.Name),
      phone: textOf(contact.Telephone),
      email: textOf(contact.ElectronicMail),
    },
  };
}

function readLine(lineNode: Record<string, unknown>, isCredit: boolean): UblLine {
  const item = (lineNode.Item as Record<string, unknown>) ?? {};
  const priceNode = (lineNode.Price as Record<string, unknown>) ?? {};
  const qtyNode = isCredit ? lineNode.CreditedQuantity : lineNode.InvoicedQuantity;
  const taxCategory = (item.ClassifiedTaxCategory as Record<string, unknown>) ?? {};

  const classifiedId = textOf((taxCategory as Record<string, unknown>).ID);
  const percent = textOf((taxCategory as Record<string, unknown>).Percent);
  const lineExtension = textOf(lineNode.LineExtensionAmount) ?? '0';
  const currency =
    numAttr(lineNode.LineExtensionAmount, 'currencyID') ??
    numAttr(priceNode.PriceAmount, 'currencyID');

  return {
    id: textOf(lineNode.ID) ?? '',
    description: textOf(item.Name) ?? textOf(item.Description) ?? '',
    note: textOf(lineNode.Note),
    quantity: textOf(qtyNode) ?? '1',
    unit_code: numAttr(qtyNode, 'unitCode'),
    unit_price: textOf(priceNode.PriceAmount) ?? '0',
    line_extension_amount: lineExtension,
    tax_percent: percent,
    tax_category: classifiedId,
    currency,
  };
}

function readTaxTotal(
  taxTotalRaw: unknown,
): UblTaxSubtotal[] {
  if (!taxTotalRaw) return [];
  const arr = Array.isArray(taxTotalRaw) ? taxTotalRaw : [taxTotalRaw];
  const out: UblTaxSubtotal[] = [];
  for (const tt of arr) {
    const subs = ((tt as Record<string, unknown>).TaxSubtotal as Array<Record<string, unknown>>) ?? [];
    for (const s of subs) {
      const category = (s.TaxCategory as Record<string, unknown>) ?? {};
      out.push({
        taxable_amount: textOf(s.TaxableAmount) ?? '0',
        tax_amount: textOf(s.TaxAmount) ?? '0',
        tax_percent: textOf(category.Percent),
        tax_category: textOf(category.ID),
      });
    }
  }
  return out;
}

function readPayment(payNode: unknown): UblPayment {
  if (!payNode) return { iban: null, bic: null, holder_name: null, reference: null, reference_type: null, means_code: null };
  const arr = Array.isArray(payNode) ? payNode : [payNode];
  for (const p of arr) {
    const pm = p as Record<string, unknown>;
    const acct = (pm.PayeeFinancialAccount as Record<string, unknown>) ?? {};
    const bic = ((acct.FinancialInstitutionBranch as Record<string, unknown>) ?? {}).ID;
    const means = (pm.PaymentMeansCode as Record<string, unknown>) ?? {};
    return {
      iban: textOf(acct.ID),
      bic: textOf(bic),
      holder_name: textOf(acct.Name),
      reference: textOf(pm.PaymentID),
      reference_type:
        numAttr(pm.InstructionID, 'schemeID') ??
        (textOf(pm.PaymentID) && /^\+{2}\d{3}\/\d{4}\/\d{5}\+{2}$/.test(textOf(pm.PaymentID) ?? '')
          ? 'structured'
          : 'free'),
      means_code: textOf(means) ?? numAttr(pm.PaymentMeansCode, 'listID'),
    };
  }
  return { iban: null, bic: null, holder_name: null, reference: null, reference_type: null, means_code: null };
}

export function parseUbl(xml: string): UblInvoice {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = (doc.Invoice ?? doc.CreditNote) as Record<string, unknown> | undefined;
  if (!root) throw new Error('Not a UBL Invoice or CreditNote document');
  const isCredit = doc.CreditNote !== undefined;

  const supplierParty =
    ((root.AccountingSupplierParty as Record<string, unknown>) ?? {}).Party ?? {};
  const customerParty =
    ((root.AccountingCustomerParty as Record<string, unknown>) ?? {}).Party ?? {};

  const linesNodeKey = isCredit ? 'CreditNoteLine' : 'InvoiceLine';
  const linesRaw =
    ((root[linesNodeKey] as Array<Record<string, unknown>>) ?? []) as Array<
      Record<string, unknown>
    >;
  const lines = linesRaw.map((l) => readLine(l, isCredit));

  const tax = readTaxTotal(root.TaxTotal);
  const totalsNode = (root.LegalMonetaryTotal as Record<string, unknown>) ?? {};

  const invoiceNumber = textOf(root.ID) ?? '';
  const currency = textOf(root.DocumentCurrencyCode) ?? lines[0]?.currency ?? 'EUR';
  const payment = readPayment(root.PaymentMeans);

  return {
    kind: isCredit ? 'CreditNote' : 'Invoice',
    profile: textOf(root.ProfileID),
    customization: textOf(root.CustomizationID),
    number: invoiceNumber,
    issue_date: textOf(root.IssueDate),
    due_date: textOf(root.DueDate),
    currency,
    language: numAttr(root.Note, 'languageID') ?? null,
    buyer_reference: textOf(root.BuyerReference) ?? textOf(root.OrderReference),
    note: textOf(root.Note),
    seller: readParty(supplierParty),
    buyer: readParty(customerParty),
    lines,
    tax_subtotals: tax,
    totals: {
      line_extension_amount: textOf(totalsNode.LineExtensionAmount),
      tax_exclusive_amount: textOf(totalsNode.TaxExclusiveAmount),
      tax_inclusive_amount: textOf(totalsNode.TaxInclusiveAmount),
      prepaid_amount: textOf(totalsNode.PrepaidAmount),
      payable_amount: textOf(totalsNode.PayableAmount),
    },
    payment,
  };
}
