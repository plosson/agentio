import { describe, expect, test } from 'bun:test';
import { decodeGmailWebId, encodeGmailWebId, gmailDraftLink } from '../../../../src/plugins/google/gmail/web-links';

// Tokens copied from Gmail web URLs, with the API IDs they belong to.
const REPLY = {
  token: 'FMfcgzQjgqKPSPRxQdrKkvsFXdjrzDnB',
  id: 'thread-f:1881195547253207870',
  threadId: '1a1b59621b12f33e',
  draftId: 'r3753822573455187771',
};
const NEW_DRAFT = {
  token: 'CqMvqmcrdzdNnHRJcfxMwZrNMxHPPQmhKQtJHnvghzqHkNsFSFKXZthDvtVbLVPzZLWsrrLQSfg',
  id: 'thread-f:1881277075304763136+msg-a:r-2301998990183903913',
  threadId: '1a1ba38855a04f00',
  draftId: 'r-2301998990183903913',
};

describe('Gmail web IDs', () => {
  test('encode the way Gmail does', () => {
    expect(encodeGmailWebId(REPLY.id)).toBe(REPLY.token);
    expect(encodeGmailWebId(NEW_DRAFT.id)).toBe(NEW_DRAFT.token);
  });

  test('decode back to the thread and draft IDs', () => {
    expect(decodeGmailWebId(REPLY.token)).toBe(REPLY.id);
    expect(decodeGmailWebId(NEW_DRAFT.token)).toBe(NEW_DRAFT.id);
  });
});

describe('gmailDraftLink', () => {
  test('a reply opens its conversation, by thread', () => {
    expect(gmailDraftLink({ account: 'plosson@docunit.be', draftId: REPLY.draftId, threadId: REPLY.threadId, inConversation: true }))
      .toBe(`https://mail.google.com/mail/u/?authuser=plosson%40docunit.be#drafts/${REPLY.token}`);
  });

  test('a draft alone in its thread opens in the composer, by thread and draft ID', () => {
    expect(gmailDraftLink({ account: 'plosson@docunit.be', draftId: NEW_DRAFT.draftId, threadId: NEW_DRAFT.threadId, inConversation: false }))
      .toBe(`https://mail.google.com/mail/u/?authuser=plosson%40docunit.be#drafts?compose=${NEW_DRAFT.token}`);
  });

  test('rejects a thread ID that is not hex', () => {
    expect(() => gmailDraftLink({ account: 'a@b.c', draftId: 'r1', threadId: 'thread-1', inConversation: true })).toThrow();
  });
});
