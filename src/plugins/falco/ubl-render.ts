import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { UblInvoice, UblParty, UblLine } from './ubl-parse';

// A4 page dimensions in PDF points.
const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;

const MARGIN_X = 40;
const MARGIN_TOP = 48;
const MARGIN_BOTTOM = 48;

const INK = rgb(0.12, 0.12, 0.12);
const MUTED = rgb(0.45, 0.45, 0.45);
const ACCENT = rgb(0.1, 0.35, 0.6);
const RULE = rgb(0.85, 0.85, 0.85);

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  cursorY: number;
};

function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.cursorY - needed < MARGIN_BOTTOM) {
    ctx.page = ctx.doc.addPage([A4_WIDTH, A4_HEIGHT]);
    ctx.cursorY = A4_HEIGHT - MARGIN_TOP;
  }
}

function drawText(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; maxWidth?: number } = {},
): void {
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.regular;
  const color = opts.color ?? INK;
  let out = text.replace(/[\u0000-\u0008\u000B-\u001F]/g, '');
  if (opts.maxWidth) {
    while (out.length > 0 && font.widthOfTextAtSize(out, size) > opts.maxWidth) {
      out = out.slice(0, -2) + '…';
    }
  }
  ctx.page.drawText(out, { x, y, size, font, color });
}

function wrap(
  font: PDFFont,
  size: number,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      if (font.widthOfTextAtSize(w, size) > maxWidth) {
        // hard-break a too-long word
        let chunk = w;
        while (font.widthOfTextAtSize(chunk, size) > maxWidth && chunk.length > 1) {
          chunk = chunk.slice(0, -1);
        }
        lines.push(chunk);
        line = w.slice(chunk.length);
      } else {
        line = w;
      }
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawHorizontalRule(ctx: Ctx, y: number): void {
  ctx.page.drawLine({
    start: { x: MARGIN_X, y },
    end: { x: A4_WIDTH - MARGIN_X, y },
    thickness: 0.5,
    color: RULE,
  });
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function formatMoney(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  return `${n.toFixed(2)} ${currency}`;
}

function addressLines(p: UblParty): string[] {
  const lines: string[] = [];
  if (p.address.street) lines.push(p.address.street);
  if (p.address.street2) lines.push(p.address.street2);
  const line3 = [p.address.zip, p.address.city].filter(Boolean).join(' ');
  if (line3) lines.push(line3);
  if (p.address.country) lines.push(p.address.country);
  return lines;
}

function drawParty(ctx: Ctx, p: UblParty, x: number, width: number): number {
  const lineHeight = 12;
  let y = ctx.cursorY;
  if (p.name) {
    drawText(ctx, p.name, x, y, { size: 10, bold: true, maxWidth: width });
    y -= lineHeight;
  }
  for (const l of addressLines(p)) {
    drawText(ctx, l, x, y, { size: 9, color: INK, maxWidth: width });
    y -= lineHeight - 1;
  }
  if (p.vat_number) {
    drawText(ctx, `VAT: ${p.vat_number}`, x, y, { size: 9, color: MUTED, maxWidth: width });
    y -= lineHeight - 1;
  }
  if (p.company_number && p.company_number !== p.vat_number) {
    drawText(ctx, `Reg. #: ${p.company_number}`, x, y, { size: 9, color: MUTED, maxWidth: width });
    y -= lineHeight - 1;
  }
  if (p.contact.email) {
    drawText(ctx, p.contact.email, x, y, { size: 9, color: MUTED, maxWidth: width });
    y -= lineHeight - 1;
  }
  if (p.contact.phone) {
    drawText(ctx, p.contact.phone, x, y, { size: 9, color: MUTED, maxWidth: width });
    y -= lineHeight - 1;
  }
  return y;
}

type Column = {
  header: string;
  width: number;
  align?: 'left' | 'right';
};

function drawLinesTable(ctx: Ctx, inv: UblInvoice): void {
  const cols: Column[] = [
    { header: '#', width: 22 },
    { header: 'Description', width: 270 },
    { header: 'Qty', width: 48, align: 'right' },
    { header: 'Unit price', width: 70, align: 'right' },
    { header: 'VAT', width: 38, align: 'right' },
    { header: 'Line total', width: 76, align: 'right' },
  ];
  const tableX = MARGIN_X;

  // Header row
  ensureSpace(ctx, 24);
  let y = ctx.cursorY;
  let x = tableX;
  ctx.page.drawRectangle({
    x: tableX,
    y: y - 14,
    width: cols.reduce((a, c) => a + c.width, 0),
    height: 18,
    color: rgb(0.95, 0.96, 0.98),
  });
  for (const col of cols) {
    const textX = col.align === 'right' ? x + col.width - 6 - ctx.bold.widthOfTextAtSize(col.header, 9) : x + 6;
    drawText(ctx, col.header, textX, y - 10, { size: 9, bold: true, color: ACCENT });
    x += col.width;
  }
  y -= 20;
  drawHorizontalRule(ctx, y + 4);
  ctx.cursorY = y;

  // Data rows
  const rowBaseHeight = 12;
  for (let i = 0; i < inv.lines.length; i++) {
    const line = inv.lines[i]!;
    const description = line.description || line.note || '';
    const wrapped = wrap(ctx.regular, 9, description, cols[1]!.width - 12);
    const rowHeight = Math.max(rowBaseHeight, wrapped.length * 11 + 4);
    ensureSpace(ctx, rowHeight + 4);
    y = ctx.cursorY;
    x = tableX;
    // draw cell values
    const values: Array<{ text: string; align: 'left' | 'right'; lines?: string[] }> = [
      { text: String(i + 1), align: 'left' },
      { text: wrapped[0] ?? '', align: 'left', lines: wrapped },
      { text: `${Number(line.quantity || 0)}${line.unit_code ? " " + line.unit_code : ""}`, align: "right" },
      { text: formatMoney(line.unit_price, inv.currency), align: 'right' },
      { text: line.tax_percent ? `${Number(line.tax_percent)}%` : "—", align: "right" },
      { text: formatMoney(line.line_extension_amount, inv.currency), align: 'right' },
    ];
    for (let j = 0; j < cols.length; j++) {
      const col = cols[j]!;
      const v = values[j]!;
      if (v.lines && v.lines.length > 1) {
        for (let k = 0; k < v.lines.length; k++) {
          drawText(ctx, v.lines[k]!, x + 6, y - 10 - k * 11, { size: 9 });
        }
      } else {
        const textX = v.align === 'right'
          ? x + col.width - 6 - ctx.regular.widthOfTextAtSize(v.text, 9)
          : x + 6;
        drawText(ctx, v.text, textX, y - 10, { size: 9 });
      }
      x += col.width;
    }
    y -= rowHeight;
    drawHorizontalRule(ctx, y + 2);
    ctx.cursorY = y;
  }
}

function drawTotalsBlock(ctx: Ctx, inv: UblInvoice): void {
  ensureSpace(ctx, 120);
  ctx.cursorY -= 10;
  const rightEdge = A4_WIDTH - MARGIN_X;
  const blockWidth = 240;
  const blockX = rightEdge - blockWidth;
  let y = ctx.cursorY;

  const rows: Array<{ label: string; value: string; bold?: boolean; color?: ReturnType<typeof rgb> }> = [];
  rows.push({
    label: 'Subtotal (excl. tax)',
    value: formatMoney(inv.totals.tax_exclusive_amount ?? inv.totals.line_extension_amount, inv.currency),
  });
  for (const t of inv.tax_subtotals) {
    rows.push({
      label: `VAT${t.tax_percent ? ` ${Number(t.tax_percent)}%` : ""}${t.tax_category ? ` [${t.tax_category}]` : ""}`,
      value: formatMoney(t.tax_amount, inv.currency),
    });
  }
  if (inv.totals.prepaid_amount && inv.totals.prepaid_amount !== '0.00' && inv.totals.prepaid_amount !== '0') {
    rows.push({ label: "Prepaid", value: `-${formatMoney(inv.totals.prepaid_amount, inv.currency)}` });
  }
  rows.push({
    label: 'Total (incl. tax)',
    value: formatMoney(inv.totals.tax_inclusive_amount ?? inv.totals.payable_amount, inv.currency),
  });
  rows.push({
    label: 'Amount due',
    value: formatMoney(inv.totals.payable_amount, inv.currency),
    bold: true,
    color: ACCENT,
  });

  for (const r of rows) {
    const labelSize = r.bold ? 11 : 10;
    const valueSize = r.bold ? 11 : 10;
    const font = r.bold ? ctx.bold : ctx.regular;
    drawText(ctx, r.label, blockX, y, { size: labelSize, bold: r.bold, color: r.color ?? INK });
    const valueWidth = font.widthOfTextAtSize(r.value, valueSize);
    drawText(ctx, r.value, rightEdge - valueWidth, y, {
      size: valueSize,
      bold: r.bold,
      color: r.color ?? INK,
    });
    y -= 14;
  }
  ctx.cursorY = y - 4;
}

function drawPaymentBlock(ctx: Ctx, inv: UblInvoice): void {
  const p = inv.payment;
  if (!p.iban && !p.reference) return;
  ensureSpace(ctx, 60);
  ctx.cursorY -= 6;
  drawHorizontalRule(ctx, ctx.cursorY);
  ctx.cursorY -= 12;
  drawText(ctx, 'Payment', MARGIN_X, ctx.cursorY, { size: 10, bold: true, color: ACCENT });
  ctx.cursorY -= 12;
  if (p.iban) {
    const line = `IBAN: ${p.iban}${p.bic ? `   BIC: ${p.bic}` : ""}`;
    drawText(ctx, line, MARGIN_X, ctx.cursorY, { size: 9 });
    ctx.cursorY -= 12;
  }
  if (p.holder_name) {
    drawText(ctx, `Beneficiary: ${p.holder_name}`, MARGIN_X, ctx.cursorY, { size: 9 });
    ctx.cursorY -= 12;
  }
  if (p.reference) {
    drawText(ctx, `Reference (${p.reference_type ?? "free"}): ${p.reference}`, MARGIN_X, ctx.cursorY, { size: 9 });
    ctx.cursorY -= 12;
  }
  if (p.means_code) {
    drawText(ctx, `Means (UNCL 4461 code): ${p.means_code}`, MARGIN_X, ctx.cursorY, { size: 9, color: MUTED });
    ctx.cursorY -= 12;
  }
}

function drawFooter(ctx: Ctx): void {
  const y = MARGIN_BOTTOM - 18;
  const text =
    'Rendered by agentio from the UBL Peppol document. ' +
    'This is a machine-generated visual rendition — the UBL XML is the legal document.';
  drawText(ctx, text, MARGIN_X, y, { size: 7.5, color: MUTED });
}

export async function renderUblToPdf(inv: UblInvoice): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${inv.kind} ${inv.number}`);
  doc.setProducer('agentio');
  doc.setCreator('agentio');
  if (inv.seller.name) doc.setAuthor(inv.seller.name);
  const page = doc.addPage([A4_WIDTH, A4_HEIGHT]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ctx: Ctx = { doc, page, regular, bold, cursorY: A4_HEIGHT - MARGIN_TOP };

  // --- Header --------------------------------------------------------------
  const titleY = ctx.cursorY;
  const title = inv.kind === 'CreditNote' ? 'CREDIT NOTE' : 'INVOICE';
  drawText(ctx, title, MARGIN_X, titleY, { size: 22, bold: true, color: ACCENT });
  const metaX = A4_WIDTH - MARGIN_X - 200;
  let metaY = titleY + 2; // align first meta line with the title's visual top
  const metaLines: Array<[string, string]> = [
    ['Number', inv.number],
    ['Issue date', formatDate(inv.issue_date)],
    ['Due date', formatDate(inv.due_date)],
    ['Currency', inv.currency],
  ];
  if (inv.buyer_reference) metaLines.push(['Buyer ref.', inv.buyer_reference]);
  for (const [label, value] of metaLines) {
    drawText(ctx, `${label}:`, metaX, metaY, { size: 9, color: MUTED });
    drawText(ctx, value, metaX + 72, metaY, { size: 9, bold: true });
    metaY -= 12;
  }
  // Drop cursor below both the title and the metadata block, with padding.
  ctx.cursorY = Math.min(titleY - 24, metaY) - 10;

  // --- Seller / Buyer columns ----------------------------------------------
  const colWidth = (A4_WIDTH - MARGIN_X * 2 - 20) / 2;
  const startY = ctx.cursorY;

  drawText(ctx, 'From', MARGIN_X, startY, { size: 8, bold: true, color: MUTED });
  drawText(ctx, 'Bill to', MARGIN_X + colWidth + 20, startY, { size: 8, bold: true, color: MUTED });
  ctx.cursorY = startY - 12;
  const leftEnd = drawParty(ctx, inv.seller, MARGIN_X, colWidth);
  const rightEnd = drawParty({ ...ctx, cursorY: ctx.cursorY }, inv.buyer, MARGIN_X + colWidth + 20, colWidth);
  ctx.cursorY = Math.min(leftEnd, rightEnd) - 12;

  if (inv.note && inv.note.trim().length > 0) {
    const noteLines = wrap(ctx.regular, 9, inv.note.trim(), A4_WIDTH - MARGIN_X * 2);
    for (const l of noteLines.slice(0, 4)) {
      drawText(ctx, l, MARGIN_X, ctx.cursorY, { size: 9, color: MUTED });
      ctx.cursorY -= 11;
    }
    ctx.cursorY -= 4;
  }

  // --- Lines table ---------------------------------------------------------
  drawLinesTable(ctx, inv);

  // --- Totals --------------------------------------------------------------
  drawTotalsBlock(ctx, inv);

  // --- Payment -------------------------------------------------------------
  drawPaymentBlock(ctx, inv);

  // --- Footer --------------------------------------------------------------
  drawFooter(ctx);

  return doc.save();
}

/**
 * Render a UBL XML string to a PDF, returning bytes. Helper for callers that
 * don't want to invoke parseUbl + renderUblToPdf separately.
 */
export async function renderUblXmlToPdf(xml: string): Promise<Uint8Array> {
  const { parseUbl } = await import('./ubl-parse');
  const inv = parseUbl(xml);
  return renderUblToPdf(inv);
}
