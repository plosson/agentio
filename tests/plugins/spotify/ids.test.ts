import { describe, expect, test } from 'bun:test';
import { CliError } from '../../../src/utils/errors';
import {
  foldName,
  parseSpotifyRef,
  resolveDevice,
  resolvePlaylistRef,
} from '../../../src/plugins/spotify/ids';
import type { SpotifyDevice, SpotifyPlaylist } from '../../../src/plugins/spotify/types';

describe('parseSpotifyRef', () => {
  test('parses URIs', () => {
    const ref = parseSpotifyRef('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
    expect(ref).toEqual({
      type: 'track',
      id: '4uLU6hMCjMI75M1A2tKUQC',
      uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
    });
  });

  test('parses open.spotify.com URLs with intl and si=', () => {
    const ref = parseSpotifyRef(
      'https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=abcd1234',
    );
    expect(ref.type).toBe('track');
    expect(ref.id).toBe('4uLU6hMCjMI75M1A2tKUQC');
  });

  test('parses bare IDs when type is known', () => {
    const ref = parseSpotifyRef('4uLU6hMCjMI75M1A2tKUQC', 'track');
    expect(ref.uri).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  });

  test('rejects bare IDs without a type', () => {
    expect(() => parseSpotifyRef('4uLU6hMCjMI75M1A2tKUQC')).toThrow(CliError);
  });

  test('rejects malformed IDs', () => {
    expect(() => parseSpotifyRef('not valid!!', 'track')).toThrow(CliError);
  });

  test('rejects wrong type for the command', () => {
    expect(() => parseSpotifyRef('spotify:album:abc123def456ghi789jk', 'playlist')).toThrow(
      /Expected a playlist/,
    );
  });

  test('parses spotify:local tracks', () => {
    const ref = parseSpotifyRef('spotify:local:Artist:Album:Track:123');
    expect(ref.type).toBe('local');
    expect(ref.uri.startsWith('spotify:local:')).toBe(true);
  });
});

describe('foldName / playlist name matching', () => {
  const playlists: SpotifyPlaylist[] = [
    { id: '1', name: 'Road Trip', uri: 'spotify:playlist:1' },
    { id: '2', name: 'road trip', uri: 'spotify:playlist:2' },
    { id: '3', name: 'Café Jazz', uri: 'spotify:playlist:3' },
  ];

  test('folds accents', () => {
    expect(foldName('Café')).toBe(foldName('Cafe'));
  });

  test('exact case-insensitive match', () => {
    const one: SpotifyPlaylist[] = [{ id: '3', name: 'Café Jazz', uri: 'spotify:playlist:3' }];
    expect(resolvePlaylistRef('cafe jazz', one).id).toBe('3');
  });

  test('several matches list candidates', () => {
    try {
      resolvePlaylistRef('road trip', playlists);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toContain('Several playlists');
      expect((err as CliError).message).toContain('spotify:playlist:1');
      expect((err as CliError).message).toContain('spotify:playlist:2');
    }
  });

  test('no match suggests playlist list', () => {
    try {
      resolvePlaylistRef('missing', playlists);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).suggestion).toContain('playlist list');
    }
  });

  test('URI still works when name looks like an ID', () => {
    const ref = resolvePlaylistRef('spotify:playlist:1', playlists);
    expect(ref.id).toBe('1');
  });
});

describe('device name matching', () => {
  const devices: SpotifyDevice[] = [
    { id: 'aaa', name: 'Living Room', type: 'Speaker', isActive: true, isRestricted: false, volumePercent: 50 },
    { id: 'bbb', name: 'living room', type: 'Computer', isActive: false, isRestricted: false, volumePercent: 30 },
    { id: 'ccc', name: 'Phone', type: 'Smartphone', isActive: false, isRestricted: false, volumePercent: 80 },
  ];

  test('matches by id', () => {
    expect(resolveDevice('ccc', devices)?.name).toBe('Phone');
  });

  test('several name matches fail', () => {
    expect(() => resolveDevice('living room', devices)).toThrow(/Several devices/);
  });

  test('active device when no input', () => {
    expect(resolveDevice(undefined, devices)?.id).toBe('aaa');
  });
});
