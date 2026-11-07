import { describe, expect, test } from 'bun:test';
import { CliError } from '../../src/utils/errors';
import {
  formatProfileListing,
  listProfileListings,
  strictListingFailure,
} from '../../src/utils/profile-commands';

const expired = (name: string) =>
  new CliError('TOKEN_EXPIRED', `Token refresh failed for gmail profile "${name}": invalid_grant`, 'Reauth the profile');

describe('listProfileListings', () => {
  test('sorts profiles by name', async () => {
    const listings = await listProfileListings([{ name: 'zed' }, { name: 'alice' }, { name: 'mike' }]);
    expect(listings.map((l) => l.name)).toEqual(['alice', 'mike', 'zed']);
  });

  test('a profile that fails carries its error and the profiles after it are still described', async () => {
    const listings = await listProfileListings(
      [{ name: 'b@x' }, { name: 'leo@x' }, { name: 'a@x' }, { name: 'z@x', readOnly: true }],
      async (name) => {
        if (name === 'leo@x') throw expired(name);
        return ` - ${name}`;
      },
    );
    expect(listings).toEqual([
      { name: 'a@x', readOnly: undefined, info: ' - a@x' },
      { name: 'b@x', readOnly: undefined, info: ' - b@x' },
      {
        name: 'leo@x',
        readOnly: undefined,
        info: '',
        error: { code: 'TOKEN_EXPIRED', message: 'Token refresh failed for gmail profile "leo@x": invalid_grant' },
      },
      { name: 'z@x', readOnly: true, info: ' - z@x' },
    ]);
  });

  test('an error that is not a CliError is reported as UNKNOWN_ERROR', async () => {
    const [listing] = await listProfileListings([{ name: 'p' }], async () => {
      throw new Error('socket hang up');
    });
    expect(listing.error).toEqual({ code: 'UNKNOWN_ERROR', message: 'socket hang up' });
  });

  test('without a describer no credentials are read', async () => {
    const listings = await listProfileListings([{ name: 'p' }]);
    expect(listings).toEqual([{ name: 'p', readOnly: undefined, info: '' }]);
  });
});

describe('formatProfileListing', () => {
  test('prints the name, read-only marker and extra info', () => {
    expect(formatProfileListing({ name: 'work', readOnly: true, info: ' - w@x' })).toBe('work [read-only] - w@x');
  });

  test('prints a failed profile with its error code and message on its own line', () => {
    const line = formatProfileListing({
      name: 'leo@x',
      info: '',
      error: { code: 'TOKEN_EXPIRED', message: 'reauth needed' },
    });
    expect(line).toBe('leo@x - ERROR TOKEN_EXPIRED: reauth needed');
  });
});

describe('strictListingFailure', () => {
  test('is null when every profile was listed', () => {
    expect(strictListingFailure('gmail', [{ name: 'a', info: '' }])).toBeNull();
  });

  test('names the failed profiles and carries the first failure code', () => {
    const failure = strictListingFailure('gmail', [
      { name: 'a', info: '' },
      { name: 'b', info: '', error: { code: 'TOKEN_EXPIRED', message: 'x' } },
      { name: 'c', info: '', error: { code: 'NETWORK_ERROR', message: 'y' } },
    ]);
    expect(failure?.code).toBe('TOKEN_EXPIRED');
    expect(failure?.message).toBe('2 of 3 gmail profiles failed: b, c');
  });
});
