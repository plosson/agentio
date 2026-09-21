import { describe, expect, test } from 'bun:test';
import { parseUbl } from '../../../src/plugins/falco/ubl-parse';
import { extractEmbeddedPdf } from '../../../src/plugins/falco/ubl';

/** A minimal Peppol BIS Billing 3.0 invoice, trimmed to the fields we read. */
const INVOICE = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>
  <cbc:ID>INV-2026-0042</cbc:ID>
  <cbc:IssueDate>2026-07-14</cbc:IssueDate>
  <cbc:DueDate>2026-08-13</cbc:DueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Acme BV</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>Kerkstraat 1</cbc:StreetName>
        <cbc:CityName>Gent</cbc:CityName>
        <cbc:PostalZone>9000</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>BE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cbc:CompanyID>BE0123456789</cbc:CompanyID></cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Losson &amp; Associ&#233;s</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cbc:PaymentID>RF18539007547034</cbc:PaymentID>
    <cac:PayeeFinancialAccount><cbc:ID>BE68539007547034</cbc:ID></cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">1000.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">1210.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">1210.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="HUR">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">1000.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Consulting</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;

describe('UBL parsing', () => {
  test('reads the invoice header', () => {
    const invoice = parseUbl(INVOICE);
    expect(invoice.number).toBe('INV-2026-0042');
    expect(invoice.issue_date).toBe('2026-07-14');
    expect(invoice.due_date).toBe('2026-08-13');
    expect(invoice.currency).toBe('EUR');
    expect(invoice.kind).toBe('Invoice');
    expect(invoice.customization).toBe('urn:cen.eu:en16931:2017');
  });

  test('reads both parties, including entity-encoded accents', () => {
    const invoice = parseUbl(INVOICE);
    expect(invoice.seller.name).toBe('Acme BV');
    expect(invoice.seller.vat_number).toBe('BE0123456789');
    expect(invoice.seller.address.city).toBe('Gent');
    expect(invoice.buyer.name).toBe('Losson & Associés');
  });

  test('reads the monetary totals', () => {
    const invoice = parseUbl(INVOICE);
    expect(invoice.totals.tax_exclusive_amount).toBe('1000.00');
    expect(invoice.totals.tax_inclusive_amount).toBe('1210.00');
    expect(invoice.totals.payable_amount).toBe('1210.00');
  });

  test('reads the payment details', () => {
    const invoice = parseUbl(INVOICE);
    expect(invoice.payment.iban).toBe('BE68539007547034');
    expect(invoice.payment.means_code).toBe('30');
    expect(invoice.payment.reference).toBe('RF18539007547034');
  });

  test('reads the invoice lines', () => {
    const invoice = parseUbl(INVOICE);
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]!.description).toBe('Consulting');
    expect(invoice.lines[0]!.quantity).toBe('10');
    expect(invoice.lines[0]!.unit_price).toBe('100.00');
  });
});

describe('embedded PDF extraction', () => {
  const embed = (attrs: string, body: string) =>
    INVOICE.replace(
      '</Invoice>',
      `<cac:AdditionalDocumentReference><cac:Attachment>` +
        `<cbc:EmbeddedDocumentBinaryObject ${attrs}>${body}</cbc:EmbeddedDocumentBinaryObject>` +
        `</cac:Attachment></cac:AdditionalDocumentReference></Invoice>`,
    );

  test('returns null when the sender embedded nothing', () => {
    expect(extractEmbeddedPdf(INVOICE)).toBeNull();
  });

  test('extracts a base64 PDF and its original filename', () => {
    const payload = Buffer.from('%PDF-1.4 fake').toString('base64');
    const found = extractEmbeddedPdf(embed('mimeCode="application/pdf" filename="invoice.pdf"', payload));

    expect(found).not.toBeNull();
    expect(found!.filename).toBe('invoice.pdf');
    expect(Buffer.from(found!.bytes).toString()).toBe('%PDF-1.4 fake');
  });

  test('tolerates whitespace inside the base64 body', () => {
    const payload = Buffer.from('%PDF-1.4 fake').toString('base64');
    const wrapped = `${payload.slice(0, 4)}\n  ${payload.slice(4)}`;
    const found = extractEmbeddedPdf(embed('mimeCode="application/pdf"', wrapped));

    expect(Buffer.from(found!.bytes).toString()).toBe('%PDF-1.4 fake');
  });

  test('skips attachments that are not PDFs', () => {
    const payload = Buffer.from('not-a-pdf').toString('base64');
    expect(extractEmbeddedPdf(embed('mimeCode="image/png" filename="logo.png"', payload))).toBeNull();
  });

  test('skips a non-PDF attachment declared with single-quoted attributes', () => {
    // XML permits either quote character. Reading only double quotes made the
    // mimeCode check fail open and hand back an image as though it were a PDF.
    const payload = Buffer.from('not-a-pdf').toString('base64');
    expect(extractEmbeddedPdf(embed("mimeCode='image/png' filename='logo.png'", payload))).toBeNull();
  });

  test('reads a single-quoted filename', () => {
    const payload = Buffer.from('%PDF-1.4 fake').toString('base64');
    const found = extractEmbeddedPdf(embed("mimeCode='application/pdf' filename='invoice.pdf'", payload));
    expect(found?.filename).toBe('invoice.pdf');
  });
});
