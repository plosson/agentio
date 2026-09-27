import { describe, expect, test } from 'bun:test';
import { CliError } from '../../../src/utils/errors';
import type { SpotifyCredentials } from '../../../src/plugins/spotify/types';

/**
 * Mirrors the guard used by commands before any network call.
 * Keep this in sync with enforceWritable in commands.ts.
 */
function enforceWritable(credentials: SpotifyCredentials, operation: string): void {
  if (credentials.readOnly) {
    throw new CliError(
      'READ_ONLY_PROFILE',
      `Cannot ${operation}: this Spotify profile is read-only`,
      'Re-add the profile without --read-only to grant write and playback scopes',
    );
  }
}

const base: SpotifyCredentials = {
  clientId: 'c',
  accessToken: 'a',
  refreshToken: 'r',
  expiryDate: Date.now() + 1000,
  authorizedAt: new Date().toISOString(),
  scopes: ['user-library-read'],
  userId: 'u',
  readOnly: true,
};

const WRITE_OPS = [
  'create a playlist',
  'add playlist items',
  'remove playlist items',
  'save library items',
  'control playback',
];

describe('read-only profile guard', () => {
  test.each(WRITE_OPS)('blocks %s before any request', (op) => {
    expect(() => enforceWritable(base, op)).toThrow(CliError);
    try {
      enforceWritable(base, op);
    } catch (err) {
      expect((err as CliError).code).toBe('READ_ONLY_PROFILE');
    }
  });

  test('allows when not read-only', () => {
    expect(() => enforceWritable({ ...base, readOnly: false }, 'control playback')).not.toThrow();
  });
});
