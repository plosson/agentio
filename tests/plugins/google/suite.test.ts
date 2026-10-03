import { describe, expect, test } from 'bun:test';
import { scopesFor } from '../../../src/plugins/google/oauth';
import {
  GOOGLE_SUITE,
  camelCredentials,
  chatCredentials,
  driveAccessLevel,
  driveCredentials,
  snakeCredentials,
  suiteEntry,
} from '../../../src/plugins/google/suite';

const tokens = { access_token: 'at', refresh_token: 'rt', expiry_date: 42, token_type: 'Bearer', scope: 's' };
const camel = { accessToken: 'at', refreshToken: 'rt', expiryDate: 42, tokenType: 'Bearer', scope: 's', email: 'me@x.com' };

describe('credential builders give what each setup stored before', () => {
  test('snake case, as gmail, gcal and gtasks store it', () => {
    expect(snakeCredentials(tokens, 'me@x.com')).toEqual({ ...tokens, email: 'me@x.com' });
  });

  test('camel case, as the other Google plugins store it', () => {
    expect(camelCredentials(tokens, 'me@x.com')).toEqual(camel);
  });

  test('Drive adds its access level, Chat its type', () => {
    expect(driveCredentials(tokens, 'me@x.com', 'readonly')).toEqual({ ...camel, accessLevel: 'readonly' });
    expect(chatCredentials(tokens, 'me@x.com')).toEqual({ ...camel, type: 'oauth' });
  });

  test('a renewal keeps fields the plugin stored, and the new tokens win', () => {
    const existing = { accessToken: 'old', refreshToken: 'old-rt', custom: true, email: 'old@x.com' };
    expect(camelCredentials(tokens, 'me@x.com', existing)).toEqual({ ...camel, custom: true });
    expect(snakeCredentials(tokens, 'me@x.com', { access_token: 'old', custom: 1 })).toEqual({ ...tokens, email: 'me@x.com', custom: 1 });
  });

  test('a renewal never turns a webhook Chat profile type into anything but oauth', () => {
    expect(chatCredentials(tokens, 'me@x.com', { type: 'webhook', webhookUrl: 'u' })).toMatchObject({ type: 'oauth' });
  });
});

describe('driveAccessLevel', () => {
  test('a new profile is full unless read-only was asked', () => {
    expect(driveAccessLevel({})).toBe('full');
    expect(driveAccessLevel({ readOnly: true })).toBe('readonly');
  });

  test('a renewal keeps the stored level, and an unknown or missing one is read-only, as before', () => {
    expect(driveAccessLevel({ existing: { accessLevel: 'full' } })).toBe('full');
    expect(driveAccessLevel({ existing: { accessLevel: 'admin' } })).toBe('readonly');
    expect(driveAccessLevel({ existing: {} })).toBe('readonly');
    expect(driveAccessLevel({ existing: { accessLevel: 'full' }, readOnly: true })).toBe('full');
  });
});

describe('GOOGLE_SUITE', () => {
  test('covers every Google plugin once, each with scopes', () => {
    const services = GOOGLE_SUITE.map((entry) => entry.service);
    expect(services).toEqual(['gmail', 'gcal', 'gtasks', 'gdrive', 'gdocs', 'gsheets', 'gslides', 'gscript', 'gchat']);
    for (const entry of GOOGLE_SUITE) expect(scopesFor([entry.scopeKey({})]).length).toBeGreaterThan(0);
  });

  test('Drive asks for the scope set of its access level', () => {
    expect(suiteEntry('gdrive')!.scopeKey({})).toBe('gdrive-full');
    expect(suiteEntry('gdrive')!.scopeKey({ readOnly: true })).toBe('gdrive-readonly');
  });

  test('only Chat has an extra check, and a non-Google service has no entry', () => {
    expect(GOOGLE_SUITE.filter((entry) => entry.verify).map((entry) => entry.service)).toEqual(['gchat']);
    expect(suiteEntry('slack')).toBeUndefined();
  });

  test('each entry builds the shape its plugin reads', () => {
    expect(suiteEntry('gmail')!.toCredentials(tokens, 'me@x.com', {})).toEqual({ ...tokens, email: 'me@x.com' });
    expect(suiteEntry('gdocs')!.toCredentials(tokens, 'me@x.com', {})).toEqual(camel);
    expect(suiteEntry('gdrive')!.toCredentials(tokens, 'me@x.com', { readOnly: true })).toEqual({ ...camel, accessLevel: 'readonly' });
    expect(suiteEntry('gchat')!.toCredentials(tokens, 'me@x.com', {})).toEqual({ ...camel, type: 'oauth' });
  });
});
