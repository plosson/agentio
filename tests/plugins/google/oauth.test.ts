import { describe, expect, test } from 'bun:test';
import { missingScopes, scopesFor } from '../../../src/plugins/google/oauth';

const G = 'https://www.googleapis.com/auth/';

describe('scopesFor', () => {
  test('lists each scope once, in the order first seen', () => {
    expect(scopesFor(['gcal', 'gtasks'])).toEqual([`${G}calendar`, `${G}userinfo.email`, `${G}tasks`]);
  });

  test('the same key twice asks for nothing more', () => {
    expect(scopesFor(['gcal', 'gcal'])).toEqual(scopesFor(['gcal']));
  });

  test('no key, no scope', () => {
    expect(scopesFor([])).toEqual([]);
  });
});

describe('missingScopes', () => {
  test('no answer or an empty answer means nothing was granted', () => {
    expect(missingScopes(['gcal'], undefined)).toEqual([`${G}calendar`, `${G}userinfo.email`]);
    expect(missingScopes(['gcal'], '')).toEqual([`${G}calendar`, `${G}userinfo.email`]);
    expect(missingScopes(['gcal'], '   ')).toEqual([`${G}calendar`, `${G}userinfo.email`]);
  });

  test('repeated spaces and unrequested scopes do not matter', () => {
    expect(missingScopes(['gcal'], `  ${G}tasks   ${G}userinfo.email  ${G}calendar `)).toEqual([]);
  });

  test('a narrower scope does not stand in for the one asked', () => {
    expect(missingScopes(['gcal'], `${G}calendar.readonly ${G}userinfo.email`)).toEqual([`${G}calendar`]);
  });

  test('full Drive stands in for drive.readonly and drive.file', () => {
    expect(missingScopes(['gsheets'], `${G}spreadsheets ${G}drive ${G}userinfo.email`)).toEqual([]);
  });

  test('drive.readonly does not stand in for full Drive', () => {
    expect(missingScopes(['gdocs'], `${G}documents ${G}drive.readonly ${G}userinfo.email`)).toEqual([`${G}drive`]);
  });
});
