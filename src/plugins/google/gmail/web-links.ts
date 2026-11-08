/**
 * Links into the Gmail web app.
 *
 * Gmail's web UI does not take the API's hex IDs in its URLs. It takes its
 * own tokens: a string such as `thread-f:<thread ID in decimal>`, with the
 * `thread-` prefix dropped, base64-encoded without padding, then rewritten
 * from the base64 alphabet into a 40-letter consonant alphabet (as a
 * base-64 to base-40 number conversion). This mirrors Gmail's own encoder.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const GMAIL_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz';
const THREAD_PREFIX = 'thread-';

function convertAlphabet(input: string, from: string, to: string): string {
  const fromBase = BigInt(from.length);
  const toBase = BigInt(to.length);
  let value = 0n;
  for (const char of input) {
    const digit = from.indexOf(char);
    if (digit < 0) throw new Error(`Character "${char}" is not in the source alphabet`);
    value = value * fromBase + BigInt(digit);
  }
  if (value === 0n) return to[0];
  let output = '';
  while (value > 0n) {
    output = to[Number(value % toBase)] + output;
    value /= toBase;
  }
  return output;
}

/** Encode a Gmail web identifier such as `thread-f:1881195547253207870`. */
export function encodeGmailWebId(id: string): string {
  const base64 = Buffer.from(id.replace(THREAD_PREFIX, ''), 'utf-8').toString('base64').replace(/=+$/, '');
  return convertAlphabet(base64, BASE64_ALPHABET, GMAIL_ALPHABET);
}

/** Decode a Gmail web token back to its identifier (the inverse of encodeGmailWebId). */
export function decodeGmailWebId(token: string): string {
  const base64 = convertAlphabet(token, GMAIL_ALPHABET, BASE64_ALPHABET);
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');
  return decoded.includes(THREAD_PREFIX) ? decoded : THREAD_PREFIX + decoded;
}

/** `thread-f:<decimal>` for an API thread ID (16 hex digits). */
function threadWebId(threadId: string): string {
  if (!/^[0-9a-f]+$/i.test(threadId)) throw new Error(`Not a Gmail thread ID: ${threadId}`);
  return `${THREAD_PREFIX}f:${BigInt(`0x${threadId}`).toString(10)}`;
}

export interface DraftLinkInput {
  /** The mailbox's address; selects the account when several are signed in. */
  account: string;
  draftId: string;
  threadId: string;
  /** True when the thread holds sent or received mail (the draft is a reply). */
  inConversation: boolean;
}

/**
 * The Gmail web link to a draft, in the form Gmail itself uses:
 * - a reply opens its conversation: `#drafts/<thread-f token>`;
 * - a draft alone in its thread opens in the composer:
 *   `#drafts?compose=<thread-f token + msg-a:<draft ID>>`.
 * Both are built from the thread ID and the draft ID, which stay the same
 * when agentio updates the draft, so the link keeps working.
 */
export function gmailDraftLink({ account, draftId, threadId, inConversation }: DraftLinkInput): string {
  const base = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}`;
  const thread = threadWebId(threadId);
  return inConversation
    ? `${base}#drafts/${encodeGmailWebId(thread)}`
    : `${base}#drafts?compose=${encodeGmailWebId(`${thread}+msg-a:${draftId}`)}`;
}
