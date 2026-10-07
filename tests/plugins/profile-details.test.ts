import { describe, expect, test } from 'bun:test';
import { profileDetails } from '../../src/plugins/profile-details';
import { findServicePlugin } from '../../src/plugins/registry';
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
      .toEqual({ account: 'me', url: 'https://mail.google.com', serviceUrl: true });
    expect(profileDetails(plugin(undefined, 'https://mail.google.com'), {})).toEqual({ url: 'https://mail.google.com', serviceUrl: true });
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
      .toEqual({ url: 'https://mail.google.com', serviceUrl: true });
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
    expect(profileDetails(plugin(() => ({ account: 'me' }), 'https://mail.google.com'), null)).toEqual({ url: 'https://mail.google.com', serviceUrl: true });
  });
});

describe('what each service shows about a profile', () => {
  // Realistic credential shapes; every secret holds a SECRET… value that must never come out.
  const cases: Array<[string, Record<string, unknown>, { account?: string; url?: string; serviceUrl?: true }]> = [
    ['gmail', { access_token: 'SECRETa', refresh_token: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://mail.google.com', serviceUrl: true }],
    ['gcal', { access_token: 'SECRETa', refresh_token: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://calendar.google.com', serviceUrl: true }],
    ['gtasks', { access_token: 'SECRETa', refresh_token: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://tasks.google.com', serviceUrl: true }],
    ['gdocs', { accessToken: 'SECRETa', refreshToken: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://docs.google.com', serviceUrl: true }],
    ['gdrive', { accessToken: 'SECRETa', refreshToken: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://drive.google.com', serviceUrl: true }],
    ['gsheets', { accessToken: 'SECRETa', refreshToken: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://sheets.google.com', serviceUrl: true }],
    ['gslides', { accessToken: 'SECRETa', refreshToken: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://slides.google.com', serviceUrl: true }],
    ['gscript', { accessToken: 'SECRETa', refreshToken: 'SECRETr', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://script.google.com', serviceUrl: true }],
    ['gchat', { accessToken: 'SECRETa', email: 'me@gmail.com' }, { account: 'me@gmail.com', url: 'https://chat.google.com', serviceUrl: true }],
    ['gchat', { webhookUrl: 'https://chat.googleapis.com/v1/spaces/SECRETw' }, { url: 'https://chat.google.com', serviceUrl: true }],
    ['github', { accessToken: 'SECRETa', username: 'plosson', email: null }, { account: 'plosson', url: 'https://github.com/plosson' }],
    ['dropbox', { accessToken: 'SECRETa', refreshToken: 'SECRETr', email: 'me@x.com', name: 'Me' }, { account: 'me@x.com', url: 'https://www.dropbox.com', serviceUrl: true }],
    ['spotify', { accessToken: 'SECRETa', refreshToken: 'SECRETr', userId: '1160970855', displayName: 'Pierre' }, { account: 'Pierre', url: 'https://open.spotify.com', serviceUrl: true }],
    ['falco', { refreshToken: 'SECRETr', userEmail: 'me@x.com', organizationName: 'Docunit' }, { account: 'me@x.com · Docunit' }],
    ['discourse', { apiKey: 'SECRETk', baseUrl: 'https://forum.example.com', username: 'pal' }, { account: 'pal', url: 'https://forum.example.com' }],
    ['kite', { token: 'SECRETt', baseUrl: 'https://kite.example.com', email: 'me@x.com' }, { account: 'me@x.com', url: 'https://kite.example.com' }],
    ['notes', { apiKey: 'SECRETk', baseUrl: 'https://mac.example.ts.net' }, { url: 'https://mac.example.ts.net' }],
    ['jev', { apiKey: 'SECRETk', model: 'jev-preview' }, { account: 'jev-preview', url: 'https://console.typesafe.ai', serviceUrl: true }],
    ['jev', { apiKey: 'SECRETk' }, { url: 'https://console.typesafe.ai', serviceUrl: true }],
    ['claude', { token: 'sk-ant-oat01-SECRETt', kind: 'oauth', model: 'opus' }, { account: 'subscription · opus', url: 'https://claude.ai', serviceUrl: true }],
    ['claude', { token: 'sk-ant-api03-SECRETt', kind: 'apiKey' }, { account: 'API key', url: 'https://claude.ai', serviceUrl: true }],
    ['jira', { accessToken: 'SECRETa', refreshToken: 'SECRETr', cloudId: 'c1', siteUrl: 'https://acme.atlassian.net' }, { url: 'https://acme.atlassian.net' }],
    ['confluence', { accessToken: 'SECRETa', refreshToken: 'SECRETr', cloudId: 'c1', siteUrl: 'https://acme.atlassian.net' }, { url: 'https://acme.atlassian.net' }],
    ['revolut', { privateKey: 'SECRETp', refreshToken: 'SECRETr', accessToken: 'SECRETa', clientId: 'id' }, { url: 'https://business.revolut.com', serviceUrl: true }],
    ['slack', { webhookUrl: 'https://hooks.slack.com/services/SECRETw', channelName: '#ops' }, { account: '#ops', url: 'https://app.slack.com', serviceUrl: true }],
    ['sql', { url: 'postgres://u:SECRETp@db.example.com/x', displayName: 'analytics' }, { account: 'analytics' }],
    ['secrets', { values: { A: 'SECRETa', B: 'SECRETb' } }, { account: '2 secrets' }],
    ['secrets', { values: { ONLY: 'SECRETo' } }, { account: '1 secret' }],
    ['pagerio', { url: 'https://pagerio.chuut.com/p/SECRETtoken12345' }, { url: 'https://pagerio.chuut.com', serviceUrl: true }],
    ['pocketalert', { apiKey: 'SECRETk' }, { url: 'https://pocketalert.app', serviceUrl: true }],
    ['whatsapp', {}, { url: 'https://web.whatsapp.com', serviceUrl: true }],
  ];

  for (const [service, credentials, expected] of cases) {
    test(`${service}: ${JSON.stringify(expected)}`, () => {
      const details = profileDetails(findServicePlugin(service), credentials);
      expect(details).toEqual(expected);
      expect(JSON.stringify(details)).not.toContain('SECRET');
    });
  }
});
