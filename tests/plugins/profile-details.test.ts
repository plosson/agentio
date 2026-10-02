import { describe, expect, test } from 'bun:test';
import { profileDetails } from '../../src/plugins/profile-details';
import type { RegisteredServicePlugin } from '../../src/plugins/types';

/** A minimal in-tree plugin whose describe hook returns whatever the test needs. */
function plugin(describe?: (credentials: any) => unknown, brandUrl?: string): RegisteredServicePlugin {
  return {
    apiVersion: 1,
    id: 'fake',
    displayName: 'Fake',
    description: 'test plugin',
    brand: brandUrl ? { url: brandUrl } : undefined,
    registerCommands: () => {},
    profile: {
      setup: async () => ({ credentials: {}, suggestedProfileName: 'x' }),
      createClient: () => ({ validate: async () => ({ valid: true }) }),
      ...(describe ? { describe: describe as never } : {}),
    },
  } as unknown as RegisteredServicePlugin;
}

describe('profileDetails', () => {
  test('passes the account and an http(s) link through, trimmed', () => {
    expect(profileDetails(plugin(() => ({ account: '  me@example.com ', url: 'https://notes.example.com ' })), {}))
      .toEqual({ account: 'me@example.com', url: 'https://notes.example.com' });
  });

  test('falls back to the service web app when the profile has no link of its own', () => {
    expect(profileDetails(plugin(() => ({ account: 'me' }), 'https://mail.google.com'), {}))
      .toEqual({ account: 'me', url: 'https://mail.google.com' });
    expect(profileDetails(plugin(undefined, 'https://mail.google.com'), {})).toEqual({ url: 'https://mail.google.com' });
  });

  test('a profile link wins over the service web app', () => {
    expect(profileDetails(plugin(() => ({ url: 'https://acme.atlassian.net' }), 'https://www.atlassian.com'), {}))
      .toEqual({ url: 'https://acme.atlassian.net' });
  });

  test('only http and https links survive, whatever the credentials hold', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'not a url', '//evil.example', 'ftp://x.example']) {
      expect(profileDetails(plugin(() => ({ url })), {})).toEqual({});
    }
    expect(profileDetails(plugin(() => ({ url: 'javascript:alert(1)' }), 'https://mail.google.com'), {}))
      .toEqual({ url: 'https://mail.google.com' });
  });

  test('a link carrying credentials is refused', () => {
    expect(profileDetails(plugin(() => ({ url: 'https://user:secret@db.example.com' })), {})).toEqual({});
  });

  test('non-string, empty and oversized values are dropped', () => {
    expect(profileDetails(plugin(() => ({ account: 42, url: { href: 'https://x.example' } })), {})).toEqual({});
    expect(profileDetails(plugin(() => ({ account: '   ', url: '' })), {})).toEqual({});
    expect(profileDetails(plugin(() => ({ account: 'a'.repeat(201) })), {})).toEqual({});
    expect(profileDetails(plugin(() => ({ url: `https://x.example/${'a'.repeat(500)}` })), {})).toEqual({});
  });

  test('a describe hook that throws or returns nothing yields no details, never an error', () => {
    expect(profileDetails(plugin(() => { throw new Error('boom'); }), {})).toEqual({});
    expect(profileDetails(plugin(() => undefined), {})).toEqual({});
    expect(profileDetails(plugin(() => null), {})).toEqual({});
  });

  test('no plugin or no credentials: no details, beyond the service web app', () => {
    expect(profileDetails(undefined, {})).toEqual({});
    expect(profileDetails(plugin(() => ({ account: 'me' }), 'https://mail.google.com'), null)).toEqual({ url: 'https://mail.google.com' });
  });
});
