import { describe, expect, test } from 'bun:test';
import {
  contactRows,
  foldName,
  messageText,
  normalizeJid,
  parseRecipient,
  phoneOf,
  resolveName,
  seconds,
  type NameRecord,
} from '../../../src/plugins/whatsapp/records';

describe('message text', () => {
  test('text messages come back as written', () => {
    expect(messageText({ conversation: 'hi' })).toBe('hi');
    expect(messageText({ extendedTextMessage: { text: 'see https://x' } })).toBe('see https://x');
  });

  test('media becomes a placeholder, with its caption when there is one, and is never kept', () => {
    expect(messageText({ imageMessage: { caption: 'look', jpegThumbnail: 'AAAA' } })).toBe('[image] look');
    expect(messageText({ imageMessage: {} })).toBe('[image]');
    expect(messageText({ audioMessage: { ptt: true } })).toBe('[voice message]');
    expect(messageText({ audioMessage: {} })).toBe('[audio]');
    expect(messageText({ documentMessage: { fileName: 'a.pdf' } })).toBe('[document: a.pdf]');
    expect(messageText({ stickerMessage: {} })).toBe('[sticker]');
    expect(messageText({ videoMessage: { gifPlayback: true } })).toBe('[gif]');
    expect(messageText({ pollCreationMessageV3: { name: 'Lunch?' } })).toBe('[poll] Lunch?');
  });

  test('wrapped messages are unwrapped, however deep', () => {
    expect(messageText({ ephemeralMessage: { message: { viewOnceMessage: { message: { conversation: 'deep' } } } } })).toBe('deep');
  });

  test('reactions, receipts and key exchanges are not messages', () => {
    expect(messageText({ reactionMessage: { text: '👍' } })).toBeNull();
    expect(messageText({ protocolMessage: { type: 0 } })).toBeNull();
    expect(messageText({ senderKeyDistributionMessage: {}, messageContextInfo: {} })).toBeNull();
    expect(messageText(null)).toBeNull();
    expect(messageText('text')).toBeNull();
    expect(messageText({})).toBeNull();
  });

  test('a kind nobody taught it still shows up, as a placeholder', () => {
    expect(messageText({ someFutureMessage: { x: 1 } })).toBe('[message]');
  });
});

describe('JIDs and numbers', () => {
  test('a device suffix and the legacy server are normalised away', () => {
    expect(normalizeJid('33612345678:12@s.whatsapp.net')).toBe('33612345678@s.whatsapp.net');
    expect(normalizeJid('33612345678@c.us')).toBe('33612345678@s.whatsapp.net');
    expect(normalizeJid('123@lid')).toBe('123@lid');
    expect(normalizeJid('no-at-sign')).toBeNull();
    expect(normalizeJid(undefined)).toBeNull();
  });

  test('only a phone JID has a number to show', () => {
    expect(phoneOf('33612345678@s.whatsapp.net')).toBe('+33612345678');
    expect(phoneOf('123@lid')).toBeUndefined();
    expect(phoneOf('1-2@g.us')).toBeUndefined();
  });

  test('timestamps come as numbers, strings or Longs, and nonsense is none', () => {
    expect(seconds(1_700_000_000)).toBe(1_700_000_000);
    expect(seconds('1700000000')).toBe(1_700_000_000);
    expect(seconds({ toNumber: () => 42 })).toBe(42);
    expect(seconds(0)).toBeUndefined();
    expect(seconds('soon')).toBeUndefined();
    expect(seconds(null)).toBeUndefined();
  });
});

describe('recipients', () => {
  test('a number in international format, with any punctuation, is a phone', () => {
    expect(parseRecipient('+33 6 12-34.56(78)')).toEqual({ kind: 'phone', digits: '33612345678' });
  });

  test('a national number is refused rather than guessed at', () => {
    expect(() => parseRecipient('0612345678')).toThrow('international format');
    expect(() => parseRecipient('+12')).toThrow('international format');
  });

  test('a JID is taken as is, and only WhatsApp\'s own servers are JIDs', () => {
    expect(parseRecipient('33612345678:4@s.whatsapp.net')).toEqual({ kind: 'jid', jid: '33612345678@s.whatsapp.net' });
    expect(parseRecipient('123-456@g.us')).toEqual({ kind: 'jid', jid: '123-456@g.us' });
    expect(() => parseRecipient('bob@example.com')).toThrow('not a WhatsApp JID');
    expect(() => parseRecipient('@s.whatsapp.net')).toThrow('not a WhatsApp JID');
  });

  test('anything else is a name, and nothing at all is refused', () => {
    expect(parseRecipient('  Bob 2 ')).toEqual({ kind: 'name', name: 'Bob 2' });
    expect(() => parseRecipient('   ')).toThrow('required');
  });
});

describe('names', () => {
  const records: NameRecord[] = [
    { jid: '33611111111@s.whatsapp.net', contact: 'Élodie Martin', self: 'Lodie' },
    { jid: '33622222222@s.whatsapp.net', contact: 'Bob', self: 'Bob' },
    { jid: '33633333333@s.whatsapp.net', self: 'Bob' },
    { jid: '999@lid', self: 'Hidden Harry' },
    { jid: '120363@g.us', group: 'Climbing' },
  ];

  test('case, accents and spacing do not count', () => {
    expect(foldName('  ÉLODIE   martin ')).toBe('elodie martin');
  });

  test('an exact name resolves, whatever its case and accents', () => {
    expect(resolveName(records, 'elodie martin')).toEqual({ jid: '33611111111@s.whatsapp.net', name: 'Élodie Martin' });
    expect(resolveName(records, 'lodie')).toEqual({ jid: '33611111111@s.whatsapp.net', name: 'Lodie' });
    expect(resolveName(records, 'climbing').jid).toBe('120363@g.us');
  });

  test('a name two people share fails and names both', () => {
    let error: any;
    try {
      resolveName(records, 'bob');
    } catch (err) {
      error = err;
    }
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toContain('+33622222222');
    expect(error.message).toContain('+33633333333');
  });

  test('one person known under the same name from two sources is not ambiguous', () => {
    expect(resolveName(records.slice(0, 2), 'Bob').jid).toBe('33622222222@s.whatsapp.net');
  });

  test('a partial name is never used to send, only suggested', () => {
    expect(() => resolveName(records, 'Elodie')).toThrow(expect.objectContaining({
      code: 'NOT_FOUND',
      message: expect.stringContaining('Élodie Martin'),
    }));
  });

  test('an unknown name points at the phone number', () => {
    expect(() => resolveName(records, 'Zed')).toThrow(expect.objectContaining({ code: 'NOT_FOUND', suggestion: expect.stringContaining('phone number') }));
  });

  test('a hidden ID resolves, and shows no number because none is known', () => {
    expect(resolveName(records, 'hidden harry').jid).toBe('999@lid');
    expect(contactRows(records, 'harry')).toEqual([{ name: 'Hidden Harry', jid: '999@lid', source: 'self' }]);
  });

  test('contacts list one row per name and source, and filter ignoring case and accents', () => {
    expect(contactRows(records, 'ELODIE')).toEqual([
      { name: 'Élodie Martin', jid: '33611111111@s.whatsapp.net', phone: '+33611111111', source: 'contact' },
    ]);
    expect(contactRows(records)).toHaveLength(7);
    expect(contactRows(records, '   ')).toHaveLength(7);
    expect(contactRows(records, 'nobody')).toEqual([]);
  });
});
