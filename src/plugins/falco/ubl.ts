// Extract an embedded PDF from a UBL Invoice/CreditNote XML document.
//
// Peppol UBL invoices may include the rendered PDF as a base64-encoded
// <cbc:EmbeddedDocumentBinaryObject mimeCode='application/pdf' filename='...'> element
// inside an <cac:AdditionalDocumentReference> > <cac:Attachment>.

const EMBEDDED_RE =
  /<(?:[a-z]+:)?EmbeddedDocumentBinaryObject\b([^>]*)>([\s\S]*?)<\/(?:[a-z]+:)?EmbeddedDocumentBinaryObject>/gi;

function readAttr(attrs: string, name: string): string | null {
  // XML allows either quote character; matching only double quotes made the
  // mimeCode guard below fail open and accept a non-PDF attachment.
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

export type EmbeddedPdf = {
  filename: string | null;
  bytes: Uint8Array;
};

/**
 * Return the first embedded PDF in the given UBL XML, or null when the sender
 * embedded none. Attachments declaring a non-PDF mime code are skipped; one
 * with no readable mimeCode at all is accepted, since omitting it is common.
 */
export function extractEmbeddedPdf(xml: string): EmbeddedPdf | null {
  EMBEDDED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBEDDED_RE.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const mime = readAttr(attrs, 'mimeCode');
    if (mime && !mime.toLowerCase().startsWith('application/pdf')) continue;
    const filename = readAttr(attrs, 'filename');
    const base64 = body.replace(/\s+/g, '');
    if (!base64) continue;
    try {
      const bytes = Buffer.from(base64, 'base64');
      return { filename, bytes: new Uint8Array(bytes) };
    } catch {
      // Skip this attachment rather than abandoning the ones after it.
      continue;
    }
  }
  return null;
}
