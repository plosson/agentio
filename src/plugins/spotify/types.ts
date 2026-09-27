export interface SpotifyCredentials {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Unix ms when the access token expires. */
  expiryDate: number;
  /** ISO timestamp of the last interactive sign-in (6-month refresh-token clock). */
  authorizedAt: string;
  scopes: string[];
  userId: string;
  displayName?: string;
  /** True when the profile requested read scopes only. */
  readOnly: boolean;
}

/** Six months after authorizedAt, Spotify refuses refresh with invalid_grant. */
export const AUTH_LIFETIME_MS = 182 * 24 * 60 * 60 * 1000;
/** Warn when fewer than this many ms remain before the 6-month expiry. */
export const AUTH_WARN_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;

export const SPOTIFY_READ_SCOPES = [
  'user-read-private',
  'user-library-read',
  'user-follow-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-top-read',
  'user-read-recently-played',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-read-playback-position',
] as const;

export const SPOTIFY_WRITE_SCOPES = [
  'user-library-modify',
  'user-follow-modify',
  'playlist-modify-public',
  'playlist-modify-private',
  'ugc-image-upload',
  'user-modify-playback-state',
] as const;

export type SpotifyItemType =
  | 'track'
  | 'album'
  | 'artist'
  | 'playlist'
  | 'show'
  | 'episode'
  | 'audiobook'
  | 'chapter';

export interface SpotifyRef {
  type: SpotifyItemType | 'local';
  id: string;
  uri: string;
}

export interface PageOptions {
  limit?: number;
  offset?: number;
  all?: boolean;
}

export interface SpotifyUser {
  id: string;
  displayName: string;
  uri: string;
  externalUrl?: string;
}

export interface SpotifyImage {
  url: string;
  height?: number | null;
  width?: number | null;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  uri: string;
  genres?: string[];
  images?: SpotifyImage[];
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  uri: string;
  artists: Array<{ id?: string; name: string; uri?: string }>;
  releaseDate?: string;
  totalTracks?: number;
  images?: SpotifyImage[];
  albumType?: string;
}

export interface SpotifyTrack {
  id: string;
  name: string;
  uri: string;
  durationMs: number;
  artists: Array<{ id?: string; name: string; uri?: string }>;
  album?: { id?: string; name: string; uri?: string };
  explicit?: boolean;
  trackNumber?: number;
  discNumber?: number;
  isLocal?: boolean;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  uri: string;
  description?: string;
  public?: boolean | null;
  collaborative?: boolean;
  ownerId?: string;
  ownerName?: string;
  snapshotId?: string;
  totalItems?: number;
  images?: SpotifyImage[];
}

export interface SpotifyPlaylistItem {
  addedAt?: string;
  addedById?: string;
  track: SpotifyTrack | null;
  episode?: SpotifyEpisode | null;
  uri?: string;
}

export interface SpotifyShow {
  id: string;
  name: string;
  uri: string;
  publisher?: string;
  description?: string;
  totalEpisodes?: number;
  images?: SpotifyImage[];
}

export interface SpotifyEpisode {
  id: string;
  name: string;
  uri: string;
  description?: string;
  durationMs: number;
  releaseDate?: string;
  show?: { id?: string; name: string; uri?: string };
  resumePoint?: { fullyPlayed?: boolean; resumePositionMs?: number };
}

export interface SpotifyAudiobook {
  id: string;
  name: string;
  uri: string;
  authors?: Array<{ name: string }>;
  narrators?: Array<{ name: string }>;
  description?: string;
  totalChapters?: number;
  images?: SpotifyImage[];
}

export interface SpotifyChapter {
  id: string;
  name: string;
  uri: string;
  chapterNumber?: number;
  durationMs: number;
  description?: string;
}

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
  volumePercent: number | null;
}

export interface SpotifyPlaybackState {
  isPlaying: boolean;
  progressMs: number | null;
  shuffleState: boolean;
  repeatState: 'off' | 'track' | 'context';
  device?: SpotifyDevice;
  context?: { type?: string; uri?: string };
  item?: SpotifyTrack | SpotifyEpisode | null;
  currentlyPlayingType?: string;
}

export interface SpotifyQueue {
  currentlyPlaying: SpotifyTrack | SpotifyEpisode | null;
  queue: Array<SpotifyTrack | SpotifyEpisode>;
}

export interface SpotifyRecentPlay {
  playedAt: string;
  track: SpotifyTrack;
  contextUri?: string;
}

export interface SavedItem<T> {
  addedAt: string;
  item: T;
}

export const API_BASE = 'https://api.spotify.com/v1';
export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const REDIRECT_PATH = '/callback';
export const LOOPBACK_HOST = '127.0.0.1';

export const SEARCH_PAGE_SIZE = 10;
export const LIBRARY_PAGE_SIZE = 50;
export const PLAYLIST_ITEMS_PAGE_SIZE = 100;
export const ALL_ITEMS_CAP = 10_000;
export const LIBRARY_BATCH_SIZE = 40;
export const PLAYLIST_BATCH_SIZE = 100;

export function authExpiresAt(authorizedAt: string): Date {
  return new Date(Date.parse(authorizedAt) + AUTH_LIFETIME_MS);
}

export function authExpiryStatus(
  authorizedAt: string,
  now = Date.now(),
): 'ok' | 'warn' | 'expired' {
  const expires = Date.parse(authorizedAt) + AUTH_LIFETIME_MS;
  if (now >= expires) return 'expired';
  if (expires - now <= AUTH_WARN_WITHIN_MS) return 'warn';
  return 'ok';
}
