import { CliError } from '../../utils/errors';
import type { SpotifyDevice, SpotifyItemType, SpotifyPlaylist, SpotifyRef } from './types';

const ITEM_TYPES: readonly SpotifyItemType[] = [
  'track', 'album', 'artist', 'playlist', 'show', 'episode', 'audiobook', 'chapter',
];

const TYPE_SET = new Set<string>(ITEM_TYPES);

/** Spotify catalog IDs are base62, typically 22 chars. Local tracks use a different form. */
const BARE_ID_RE = /^[0-9A-Za-z]{14,128}$/;

export function isItemType(value: string): value is SpotifyItemType {
  return TYPE_SET.has(value);
}

export function spotifyUri(type: SpotifyItemType | 'local', id: string): string {
  return `spotify:${type}:${id}`;
}

/**
 * Parse a Spotify URI, open.spotify.com URL (with optional /intl-xx/ and ?si=),
 * or a bare ID when `expectedType` is given.
 */
export function parseSpotifyRef(
  input: string,
  expectedType?: SpotifyItemType | SpotifyItemType[],
): SpotifyRef {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new CliError('INVALID_PARAMS', 'Spotify identifier is empty');
  }

  const allowed = expectedType
    ? new Set(Array.isArray(expectedType) ? expectedType : [expectedType])
    : null;

  // URI: spotify:track:ID or spotify:local:...
  const uriMatch = /^spotify:([a-z]+):(.+)$/i.exec(trimmed);
  if (uriMatch) {
    const typeRaw = uriMatch[1].toLowerCase();
    const id = uriMatch[2];
    if (typeRaw === 'local') {
      if (allowed && !allowed.has('track' as SpotifyItemType)) {
        // local tracks are track-like for reading; reject when a non-track type is required
      }
      return { type: 'local', id, uri: `spotify:local:${id}` };
    }
    if (!isItemType(typeRaw)) {
      throw new CliError('INVALID_PARAMS', `Unsupported Spotify URI type: ${typeRaw}`);
    }
    if (allowed && !allowed.has(typeRaw)) {
      throw new CliError(
        'INVALID_PARAMS',
        `Expected a ${[...allowed].join(' or ')} but got ${typeRaw} URI`,
      );
    }
    return { type: typeRaw, id, uri: spotifyUri(typeRaw, id) };
  }

  // open.spotify.com URL, including /intl-fr/ paths and ?si=
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed);
      if (!/^(open\.)?spotify\.com$/i.test(url.hostname) && url.hostname !== 'spotify.link') {
        throw new CliError('INVALID_PARAMS', `Not a Spotify URL: ${trimmed}`);
      }
      const parts = url.pathname.split('/').filter(Boolean);
      // ["intl-fr", "track", "ID"] or ["track", "ID"]
      let idx = 0;
      if (parts[0] && /^intl-/i.test(parts[0])) idx = 1;
      const typeRaw = (parts[idx] || '').toLowerCase();
      const id = parts[idx + 1];
      if (!id || !isItemType(typeRaw)) {
        throw new CliError('INVALID_PARAMS', `Could not parse Spotify URL: ${trimmed}`);
      }
      if (allowed && !allowed.has(typeRaw)) {
        throw new CliError(
          'INVALID_PARAMS',
          `Expected a ${[...allowed].join(' or ')} but got ${typeRaw} URL`,
        );
      }
      return { type: typeRaw, id, uri: spotifyUri(typeRaw, id) };
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('INVALID_PARAMS', `Could not parse Spotify URL: ${trimmed}`);
  }

  // Bare ID
  if (!allowed || allowed.size !== 1) {
    throw new CliError(
      'INVALID_PARAMS',
      `Bare Spotify ID requires a known type: ${trimmed}`,
      'Pass a URI (spotify:track:…) or an open.spotify.com URL, or use a command that implies the type',
    );
  }
  if (!BARE_ID_RE.test(trimmed)) {
    throw new CliError('INVALID_PARAMS', `Malformed Spotify ID: ${trimmed}`);
  }
  const type = [...allowed][0];
  return { type, id: trimmed, uri: spotifyUri(type, trimmed) };
}

/** Fold accents and case for name matching. */
export function foldName(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Resolve a playlist argument that may be a URI, URL, ID, or name.
 * Name matching is case- and accent-insensitive against the user's playlists.
 */
export function resolvePlaylistRef(
  input: string,
  playlists: SpotifyPlaylist[],
): SpotifyPlaylist {
  const trimmed = input.trim();

  // Prefer structured identifiers first.
  try {
    if (
      trimmed.startsWith('spotify:')
      || trimmed.startsWith('http://')
      || trimmed.startsWith('https://')
      || BARE_ID_RE.test(trimmed)
    ) {
      const ref = parseSpotifyRef(trimmed, 'playlist');
      const found = playlists.find((p) => p.id === ref.id);
      if (found) return found;
      // ID may be valid even if not in the cached list (e.g. not yet loaded).
      return {
        id: ref.id,
        name: ref.id,
        uri: ref.uri,
      };
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    // Fall through to name matching when the bare ID pattern fails, or when
    // the user passed a name that happens to look unusual.
  }

  const needle = foldName(trimmed);
  const matches = playlists.filter((p) => foldName(p.name) === needle);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const list = matches.map((p) => `  ${p.name}  ${p.uri}`).join('\n');
    throw new CliError(
      'INVALID_PARAMS',
      `Several playlists match "${trimmed}":\n${list}`,
      'Pass the playlist URI or ID to disambiguate',
    );
  }

  // Partial / contains match as a soft fallback for "looks like an ID" miss?
  // Spec: no match → fail with suggestion to run playlist list.
  throw new CliError(
    'INVALID_PARAMS',
    `No playlist matches "${trimmed}"`,
    'Run: agentio spotify playlist list',
  );
}

export function resolveDevice(
  input: string | undefined,
  devices: SpotifyDevice[],
): SpotifyDevice | undefined {
  if (!input) {
    const active = devices.find((d) => d.isActive);
    return active;
  }
  const trimmed = input.trim();
  const byId = devices.find((d) => d.id === trimmed);
  if (byId) return byId;

  const needle = foldName(trimmed);
  const matches = devices.filter((d) => foldName(d.name) === needle);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const list = matches.map((d) => `  ${d.name}  ${d.id ?? '(no id)'}`).join('\n');
    throw new CliError(
      'INVALID_PARAMS',
      `Several devices match "${trimmed}":\n${list}`,
      'Pass the device ID to disambiguate',
    );
  }
  throw new CliError(
    'INVALID_PARAMS',
    `No device matches "${trimmed}"`,
    'Run: agentio spotify player devices',
  );
}

export function formatDeviceList(devices: SpotifyDevice[]): string {
  if (devices.length === 0) return '  (no devices — open Spotify on a phone, desktop, or web player)';
  return devices
    .map((d) => {
      const active = d.isActive ? ' [active]' : '';
      return `  ${d.name} (${d.type}) id=${d.id ?? '?'}${active}`;
    })
    .join('\n');
}
