/**
 * Split text into chunks no larger than `maxChars`, preferring paragraph then
 * sentence boundaries. Whitespace at boundaries is dropped; raw character
 * content within each chunk is preserved.
 */
export function splitReply(input: string, maxChars: number): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];

  const out: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);

    let cut = window.lastIndexOf('\n\n');
    if (cut < maxChars * 0.5) cut = -1;  // too early; ignore

    if (cut < 0) {
      const sentence = window.lastIndexOf('. ');
      if (sentence >= maxChars * 0.5) cut = sentence + 1;  // include the period
    }

    if (cut < 0) cut = maxChars;  // hard split

    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }

  if (remaining.length > 0) out.push(remaining);
  return out;
}
