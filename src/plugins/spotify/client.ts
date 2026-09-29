import { CliError, httpStatusToErrorCode } from '../../utils/errors';
import { chunk } from '../../utils/batch';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { formatDeviceList } from './ids';
import type {
  PageOptions,
  SavedItem,
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyAudiobook,
  SpotifyChapter,
  SpotifyCredentials,
  SpotifyDevice,
  SpotifyEpisode,
  SpotifyPlaybackState,
  SpotifyPlaylist,
  SpotifyPlaylistItem,
  SpotifyQueue,
  SpotifyRecentPlay,
  SpotifyShow,
  SpotifyTrack,
  SpotifyUser,
} from './types';
import {
  ALL_ITEMS_CAP,
  API_BASE,
  LIBRARY_BATCH_SIZE,
  LIBRARY_PAGE_SIZE,
  PLAYLIST_BATCH_SIZE,
  PLAYLIST_ITEMS_PAGE_SIZE,
  SEARCH_PAGE_SIZE,
  authExpiryStatus,
  authExpiresAt,
} from './types';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asTrack(raw: any): SpotifyTrack {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    durationMs: raw.duration_ms ?? 0,
    artists: (raw.artists ?? []).map((a: any) => ({ id: a.id, name: a.name, uri: a.uri })),
    album: raw.album
      ? { id: raw.album.id, name: raw.album.name, uri: raw.album.uri }
      : undefined,
    explicit: raw.explicit,
    trackNumber: raw.track_number,
    discNumber: raw.disc_number,
    isLocal: raw.is_local,
  };
}

function asArtist(raw: any): SpotifyArtist {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    genres: raw.genres,
    images: raw.images,
  };
}

function asAlbum(raw: any): SpotifyAlbum {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    artists: (raw.artists ?? []).map((a: any) => ({ id: a.id, name: a.name, uri: a.uri })),
    releaseDate: raw.release_date,
    totalTracks: raw.total_tracks,
    images: raw.images,
    albumType: raw.album_type,
  };
}

function asPlaylist(raw: any): SpotifyPlaylist {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    description: raw.description ?? undefined,
    public: raw.public,
    collaborative: raw.collaborative,
    ownerId: raw.owner?.id,
    ownerName: raw.owner?.display_name,
    snapshotId: raw.snapshot_id,
    totalItems: raw.tracks?.total ?? raw.items?.total,
    images: raw.images,
  };
}

function asShow(raw: any): SpotifyShow {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    publisher: raw.publisher,
    description: raw.description,
    totalEpisodes: raw.total_episodes,
    images: raw.images,
  };
}

function asEpisode(raw: any): SpotifyEpisode {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    description: raw.description,
    durationMs: raw.duration_ms ?? 0,
    releaseDate: raw.release_date,
    show: raw.show ? { id: raw.show.id, name: raw.show.name, uri: raw.show.uri } : undefined,
    resumePoint: raw.resume_point
      ? {
          fullyPlayed: raw.resume_point.fully_played,
          resumePositionMs: raw.resume_point.resume_position_ms,
        }
      : undefined,
  };
}

function asAudiobook(raw: any): SpotifyAudiobook {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    authors: raw.authors,
    narrators: raw.narrators,
    description: raw.description,
    totalChapters: raw.total_chapters,
    images: raw.images,
  };
}

function asChapter(raw: any): SpotifyChapter {
  return {
    id: raw.id,
    name: raw.name,
    uri: raw.uri,
    chapterNumber: raw.chapter_number,
    durationMs: raw.duration_ms ?? 0,
    description: raw.description,
  };
}

function asDevice(raw: any): SpotifyDevice {
  return {
    id: raw.id ?? null,
    name: raw.name,
    type: raw.type,
    isActive: !!raw.is_active,
    isRestricted: !!raw.is_restricted,
    volumePercent: raw.volume_percent ?? null,
  };
}

function asPlayable(raw: any): SpotifyTrack | SpotifyEpisode | null {
  if (!raw) return null;
  if (raw.type === 'episode') return asEpisode(raw);
  return asTrack(raw);
}

export class SpotifyClient implements ServiceClient {
  constructor(private credentials: SpotifyCredentials) {}

  getCredentials(): SpotifyCredentials {
    return this.credentials;
  }

  async validate(): Promise<ValidationResult> {
    try {
      const status = authExpiryStatus(this.credentials.authorizedAt);
      if (status === 'expired') {
        return {
          valid: false,
          error: `Spotify sign-in expired on ${authExpiresAt(this.credentials.authorizedAt).toISOString()} — reauth required`,
        };
      }
      const me = await this.me();
      const expires = authExpiresAt(this.credentials.authorizedAt).toISOString();
      const warn = status === 'warn' ? ` ⚠ sign-in expires ${expires}` : '';
      return {
        valid: true,
        info: `${me.displayName || me.id}${warn}`,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async me(): Promise<SpotifyUser> {
    const raw = await this.request<any>('GET', '/me');
    return {
      id: raw.id,
      displayName: raw.display_name || raw.id,
      uri: raw.uri,
      externalUrl: raw.external_urls?.spotify,
    };
  }

  // ---- Catalog ----

  async search(options: {
    query: string;
    types: string[];
    limit?: number;
    offset?: number;
    market?: string;
  }): Promise<{ type: string; items: unknown[] }[]> {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const offset = options.offset ?? 0;
    if (offset + limit > 1000) {
      throw new CliError(
        'INVALID_PARAMS',
        'Spotify search offset + limit cannot exceed 1000',
        'Use a smaller --offset or --limit',
      );
    }

    const collected: Record<string, unknown[]> = {};
    for (const t of options.types) collected[t] = [];

    let remaining = limit;
    let pageOffset = offset;
    while (remaining > 0) {
      const pageSize = Math.min(SEARCH_PAGE_SIZE, remaining);
      const params = new URLSearchParams({
        q: options.query,
        type: options.types.join(','),
        limit: String(pageSize),
        offset: String(pageOffset),
      });
      if (options.market) params.set('market', options.market);

      const raw = await this.request<any>('GET', `/search?${params}`);
      let got = 0;
      for (const t of options.types) {
        const key = `${t}s`;
        const page = raw[key]?.items ?? [];
        collected[t].push(...page.map((item: any) => this.mapSearchItem(t, item)));
        got = Math.max(got, page.length);
      }
      remaining -= pageSize;
      pageOffset += pageSize;
      if (got < pageSize) break;
    }

    return options.types.map((t) => ({ type: t, items: collected[t] }));
  }

  private mapSearchItem(type: string, raw: any): unknown {
    switch (type) {
      case 'track': return asTrack(raw);
      case 'album': return asAlbum(raw);
      case 'artist': return asArtist(raw);
      case 'playlist': return asPlaylist(raw);
      case 'show': return asShow(raw);
      case 'episode': return asEpisode(raw);
      case 'audiobook': return asAudiobook(raw);
      default: return raw;
    }
  }

  async get(type: string, id: string): Promise<unknown> {
    const plural = type === 'audiobook' ? 'audiobooks'
      : type.endsWith('s') ? type : `${type}s`;
    // chapters live under /chapters/{id}
    const path = `/${plural}/${id}`;
    const raw = await this.request<any>('GET', path);
    return this.mapSearchItem(type, raw);
  }

  async albumTracks(albumId: string, page: PageOptions = {}): Promise<{ items: SpotifyTrack[]; total: number }> {
    return this.offsetPage<SpotifyTrack>(
      `/albums/${albumId}/tracks`,
      page,
      LIBRARY_PAGE_SIZE,
      (raw) => asTrack({ ...raw, album: undefined }),
    );
  }

  async artistAlbums(
    artistId: string,
    page: PageOptions & { include?: string[] } = {},
  ): Promise<{ items: SpotifyAlbum[]; total: number }> {
    const extra = new URLSearchParams();
    if (page.include?.length) extra.set('include_groups', page.include.join(','));
    return this.offsetPage<SpotifyAlbum>(
      `/artists/${artistId}/albums`,
      page,
      LIBRARY_PAGE_SIZE,
      asAlbum,
      extra,
    );
  }

  async showEpisodes(showId: string, page: PageOptions = {}): Promise<{ items: SpotifyEpisode[]; total: number }> {
    return this.offsetPage(`/shows/${showId}/episodes`, page, LIBRARY_PAGE_SIZE, asEpisode);
  }

  async audiobookChapters(audiobookId: string, page: PageOptions = {}): Promise<{ items: SpotifyChapter[]; total: number }> {
    return this.offsetPage(`/audiobooks/${audiobookId}/chapters`, page, LIBRARY_PAGE_SIZE, asChapter);
  }

  // ---- Playlists ----

  async listPlaylists(page: PageOptions = {}): Promise<{ items: SpotifyPlaylist[]; total: number }> {
    return this.offsetPage('/me/playlists', page, LIBRARY_PAGE_SIZE, asPlaylist);
  }

  async allPlaylists(): Promise<SpotifyPlaylist[]> {
    const { items } = await this.listPlaylists({ all: true });
    return items;
  }

  async getPlaylist(id: string): Promise<SpotifyPlaylist> {
    const raw = await this.request<any>('GET', `/playlists/${id}`);
    return asPlaylist(raw);
  }

  async playlistItems(id: string, page: PageOptions = {}): Promise<{ items: SpotifyPlaylistItem[]; total: number; playlist?: SpotifyPlaylist }> {
    try {
      return await this.offsetPage<SpotifyPlaylistItem>(
        `/playlists/${id}/items`,
        page,
        PLAYLIST_ITEMS_PAGE_SIZE,
        (raw) => {
          const track = raw.track?.type === 'episode' ? null : raw.track ? asTrack(raw.track) : null;
          const episode = raw.track?.type === 'episode' ? asEpisode(raw.track) : null;
          return {
            addedAt: raw.added_at,
            addedById: raw.added_by?.id,
            track,
            episode,
            uri: raw.track?.uri,
          };
        },
      );
    } catch (err) {
      if (err instanceof CliError && err.code === 'PERMISSION_DENIED') {
        throw new CliError(
          'PERMISSION_DENIED',
          'Spotify only returns items for playlists you own or collaborate on.',
          'Use a playlist you own, or ask the owner to add you as a collaborator',
        );
      }
      throw err;
    }
  }

  async createPlaylist(options: {
    name: string;
    description?: string;
    isPublic?: boolean;
    collaborative?: boolean;
  }): Promise<SpotifyPlaylist> {
    const body = {
      name: options.name,
      description: options.description ?? '',
      public: options.collaborative ? false : (options.isPublic ?? false),
      collaborative: options.collaborative ?? false,
    };
    const raw = await this.request<any>('POST', '/me/playlists', body);
    return asPlaylist(raw);
  }

  async updatePlaylist(
    id: string,
    options: {
      name?: string;
      description?: string;
      isPublic?: boolean;
      collaborative?: boolean;
    },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (options.name !== undefined) body.name = options.name;
    if (options.description !== undefined) body.description = options.description;
    if (options.isPublic !== undefined) body.public = options.isPublic;
    if (options.collaborative !== undefined) body.collaborative = options.collaborative;
    await this.request('PUT', `/playlists/${id}`, body);
  }

  async addPlaylistItems(
    id: string,
    uris: string[],
    options: { position?: number } = {},
  ): Promise<{ snapshotId: string; added: number }> {
    let snapshotId = '';
    let added = 0;
    let position = options.position;
    for (const batch of chunk(uris, PLAYLIST_BATCH_SIZE)) {
      const body: Record<string, unknown> = { uris: batch };
      if (position !== undefined) body.position = position;
      const raw = await this.request<{ snapshot_id: string }>('POST', `/playlists/${id}/items`, body);
      snapshotId = raw.snapshot_id;
      added += batch.length;
      if (position !== undefined) position += batch.length;
    }
    return { snapshotId, added };
  }

  async removePlaylistItems(
    id: string,
    uris: string[],
    snapshotId?: string,
  ): Promise<{ snapshotId: string; removed: number }> {
    let lastSnapshot = snapshotId ?? '';
    let removed = 0;
    for (const batch of chunk(uris, PLAYLIST_BATCH_SIZE)) {
      const body: Record<string, unknown> = {
        tracks: batch.map((uri) => ({ uri })),
      };
      if (lastSnapshot) body.snapshot_id = lastSnapshot;
      const raw = await this.request<{ snapshot_id: string }>('DELETE', `/playlists/${id}/items`, body);
      lastSnapshot = raw.snapshot_id;
      removed += batch.length;
    }
    return { snapshotId: lastSnapshot, removed };
  }

  async reorderPlaylistItems(
    id: string,
    options: { rangeStart: number; insertBefore: number; rangeLength?: number; snapshotId?: string },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      range_start: options.rangeStart,
      insert_before: options.insertBefore,
      range_length: options.rangeLength ?? 1,
    };
    if (options.snapshotId) body.snapshot_id = options.snapshotId;
    const raw = await this.request<{ snapshot_id: string }>('PUT', `/playlists/${id}/items`, body);
    return raw.snapshot_id;
  }

  async replacePlaylistItems(id: string, uris: string[]): Promise<string> {
    const first = uris.slice(0, PLAYLIST_BATCH_SIZE);
    const rest = uris.slice(PLAYLIST_BATCH_SIZE);
    const raw = await this.request<{ snapshot_id?: string }>('PUT', `/playlists/${id}/items`, { uris: first });
    let snapshotId = raw.snapshot_id ?? '';
    if (rest.length > 0) {
      const added = await this.addPlaylistItems(id, rest);
      snapshotId = added.snapshotId;
    }
    return snapshotId;
  }

  async getPlaylistCover(id: string): Promise<Array<{ url: string; height?: number; width?: number }>> {
    return this.request('GET', `/playlists/${id}/images`);
  }

  async setPlaylistCover(id: string, jpegBase64: string): Promise<void> {
    await this.requestRaw('PUT', `/playlists/${id}/images`, jpegBase64, {
      'Content-Type': 'image/jpeg',
    });
  }

  // ---- Library ----

  async libraryTracks(page: PageOptions = {}): Promise<{ items: SavedItem<SpotifyTrack>[]; total: number }> {
    return this.offsetPage('/me/tracks', page, LIBRARY_PAGE_SIZE, (raw) => ({
      addedAt: raw.added_at,
      item: asTrack(raw.track),
    }));
  }

  async libraryAlbums(page: PageOptions = {}): Promise<{ items: SavedItem<SpotifyAlbum>[]; total: number }> {
    return this.offsetPage('/me/albums', page, LIBRARY_PAGE_SIZE, (raw) => ({
      addedAt: raw.added_at,
      item: asAlbum(raw.album),
    }));
  }

  async libraryShows(page: PageOptions = {}): Promise<{ items: SavedItem<SpotifyShow>[]; total: number }> {
    return this.offsetPage('/me/shows', page, LIBRARY_PAGE_SIZE, (raw) => ({
      addedAt: raw.added_at,
      item: asShow(raw.show),
    }));
  }

  async libraryEpisodes(page: PageOptions = {}): Promise<{ items: SavedItem<SpotifyEpisode>[]; total: number }> {
    return this.offsetPage('/me/episodes', page, LIBRARY_PAGE_SIZE, (raw) => ({
      addedAt: raw.added_at,
      item: asEpisode(raw.episode),
    }));
  }

  async libraryAudiobooks(page: PageOptions = {}): Promise<{ items: SavedItem<SpotifyAudiobook>[]; total: number }> {
    return this.offsetPage('/me/audiobooks', page, LIBRARY_PAGE_SIZE, (raw) => ({
      addedAt: raw.added_at,
      item: asAudiobook(raw.audiobook ?? raw),
    }));
  }

  async libraryArtists(page: PageOptions = {}): Promise<{ items: SpotifyArtist[]; total: number; cursors?: { after?: string } }> {
    // Followed artists use cursor paging.
    const limit = page.all ? ALL_ITEMS_CAP : (page.limit ?? LIBRARY_PAGE_SIZE);
    const items: SpotifyArtist[] = [];
    let after: string | undefined;
    let capped = false;

    while (items.length < limit) {
      const pageSize = Math.min(LIBRARY_PAGE_SIZE, limit - items.length);
      const params = new URLSearchParams({ type: 'artist', limit: String(pageSize) });
      if (after) params.set('after', after);
      const raw = await this.request<any>('GET', `/me/following?${params}`);
      const page = (raw.artists?.items ?? []).map(asArtist);
      items.push(...page);
      after = raw.artists?.cursors?.after;
      if (!after || page.length === 0) break;
      if (items.length >= ALL_ITEMS_CAP) {
        capped = true;
        break;
      }
    }

    if (capped || (page.all && items.length >= ALL_ITEMS_CAP)) {
      console.error(`Warning: --all stopped at ${ALL_ITEMS_CAP} items`);
    }

    return { items: items.slice(0, limit), total: items.length, cursors: after ? { after } : undefined };
  }

  async librarySave(uris: string[]): Promise<void> {
    for (const batch of chunk(uris, LIBRARY_BATCH_SIZE)) {
      // Spotify expects `uris` as a query param (not JSON body) on PUT/DELETE /me/library.
      const params = new URLSearchParams({ uris: batch.join(',') });
      await this.requestAllowEmpty('PUT', `/me/library?${params}`);
    }
  }

  async libraryRemove(uris: string[]): Promise<void> {
    for (const batch of chunk(uris, LIBRARY_BATCH_SIZE)) {
      const params = new URLSearchParams({ uris: batch.join(',') });
      await this.requestAllowEmpty('DELETE', `/me/library?${params}`);
    }
  }

  async libraryContains(uris: string[]): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const batch of chunk(uris, LIBRARY_BATCH_SIZE)) {
      const params = new URLSearchParams({ uris: batch.join(',') });
      const raw = await this.request<boolean[]>('GET', `/me/library/contains?${params}`);
      results.push(...raw);
    }
    return results;
  }

  // ---- History / top ----

  async recentlyPlayed(options: {
    limit?: number;
    after?: number;
    before?: number;
  } = {}): Promise<SpotifyRecentPlay[]> {
    const limit = Math.min(options.limit ?? 50, 50);
    const params = new URLSearchParams({ limit: String(limit) });
    if (options.after !== undefined) params.set('after', String(options.after));
    if (options.before !== undefined) params.set('before', String(options.before));
    const raw = await this.request<any>('GET', `/me/player/recently-played?${params}`);
    return (raw.items ?? []).map((item: any) => ({
      playedAt: item.played_at,
      track: asTrack(item.track),
      contextUri: item.context?.uri,
    }));
  }

  async topTracks(
    range: 'short_term' | 'medium_term' | 'long_term',
    page: PageOptions = {},
  ): Promise<{ items: SpotifyTrack[]; total: number }> {
    return this.offsetPage(
      '/me/top/tracks',
      page,
      LIBRARY_PAGE_SIZE,
      asTrack,
      new URLSearchParams({ time_range: range }),
    );
  }

  async topArtists(
    range: 'short_term' | 'medium_term' | 'long_term',
    page: PageOptions = {},
  ): Promise<{ items: SpotifyArtist[]; total: number }> {
    return this.offsetPage(
      '/me/top/artists',
      page,
      LIBRARY_PAGE_SIZE,
      asArtist,
      new URLSearchParams({ time_range: range }),
    );
  }

  // ---- Player ----

  async playerState(): Promise<SpotifyPlaybackState | null> {
    const raw = await this.requestAllowEmpty<any>('GET', '/me/player');
    if (!raw) return null;
    return {
      isPlaying: !!raw.is_playing,
      progressMs: raw.progress_ms ?? null,
      shuffleState: !!raw.shuffle_state,
      repeatState: raw.repeat_state ?? 'off',
      device: raw.device ? asDevice(raw.device) : undefined,
      context: raw.context ? { type: raw.context.type, uri: raw.context.uri } : undefined,
      item: asPlayable(raw.item),
      currentlyPlayingType: raw.currently_playing_type,
    };
  }

  async devices(): Promise<SpotifyDevice[]> {
    const raw = await this.request<{ devices: any[] }>('GET', '/me/player/devices');
    return (raw.devices ?? []).map(asDevice);
  }

  async play(options: {
    deviceId?: string;
    uris?: string[];
    contextUri?: string;
    offset?: { position?: number; uri?: string };
    positionMs?: number;
  } = {}): Promise<void> {
    const params = new URLSearchParams();
    if (options.deviceId) params.set('device_id', options.deviceId);
    const body: Record<string, unknown> = {};
    if (options.uris) body.uris = options.uris;
    if (options.contextUri) body.context_uri = options.contextUri;
    if (options.offset) body.offset = options.offset;
    if (options.positionMs !== undefined) body.position_ms = options.positionMs;
    const q = params.toString();
    await this.requestAllowEmpty('PUT', `/me/player/play${q ? `?${q}` : ''}`, Object.keys(body).length ? body : undefined);
  }

  async pause(deviceId?: string): Promise<void> {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.requestAllowEmpty('PUT', `/me/player/pause${q}`);
  }

  async next(deviceId?: string): Promise<void> {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.requestAllowEmpty('POST', `/me/player/next${q}`);
  }

  async previous(deviceId?: string): Promise<void> {
    const q = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    await this.requestAllowEmpty('POST', `/me/player/previous${q}`);
  }

  async seek(positionMs: number, deviceId?: string): Promise<void> {
    const params = new URLSearchParams({ position_ms: String(positionMs) });
    if (deviceId) params.set('device_id', deviceId);
    await this.requestAllowEmpty('PUT', `/me/player/seek?${params}`);
  }

  async volume(percent: number, deviceId?: string): Promise<void> {
    const params = new URLSearchParams({ volume_percent: String(percent) });
    if (deviceId) params.set('device_id', deviceId);
    await this.requestAllowEmpty('PUT', `/me/player/volume?${params}`);
  }

  async shuffle(state: boolean, deviceId?: string): Promise<void> {
    const params = new URLSearchParams({ state: String(state) });
    if (deviceId) params.set('device_id', deviceId);
    await this.requestAllowEmpty('PUT', `/me/player/shuffle?${params}`);
  }

  async repeat(state: 'off' | 'track' | 'context', deviceId?: string): Promise<void> {
    const params = new URLSearchParams({ state });
    if (deviceId) params.set('device_id', deviceId);
    await this.requestAllowEmpty('PUT', `/me/player/repeat?${params}`);
  }

  async queue(): Promise<SpotifyQueue> {
    const raw = await this.request<any>('GET', '/me/player/queue');
    return {
      currentlyPlaying: asPlayable(raw.currently_playing),
      queue: (raw.queue ?? []).map(asPlayable).filter(Boolean),
    };
  }

  async queueAdd(uri: string, deviceId?: string): Promise<void> {
    const params = new URLSearchParams({ uri });
    if (deviceId) params.set('device_id', deviceId);
    await this.requestAllowEmpty('POST', `/me/player/queue?${params}`);
  }

  async transfer(deviceId: string, play?: boolean): Promise<void> {
    await this.requestAllowEmpty('PUT', '/me/player', {
      device_ids: [deviceId],
      play: play ?? false,
    });
  }

  // ---- Internals ----

  private async offsetPage<T>(
    path: string,
    page: PageOptions,
    spotifyPageSize: number,
    map: (raw: any) => T,
    extraParams?: URLSearchParams,
  ): Promise<{ items: T[]; total: number }> {
    const wantAll = !!page.all;
    const limit = wantAll ? ALL_ITEMS_CAP : (page.limit ?? spotifyPageSize);
    const startOffset = page.offset ?? 0;
    const items: T[] = [];
    let total = 0;
    let offset = startOffset;
    let hitCap = false;

    while (items.length < limit) {
      const pageSize = Math.min(spotifyPageSize, limit - items.length);
      const params = new URLSearchParams(extraParams);
      params.set('limit', String(pageSize));
      params.set('offset', String(offset));
      const sep = path.includes('?') ? '&' : '?';
      const raw = await this.request<any>('GET', `${path}${sep}${params}`);
      total = raw.total ?? total;
      const pageItems = (raw.items ?? []).map(map);
      items.push(...pageItems);
      offset += pageItems.length;
      if (pageItems.length === 0 || pageItems.length < pageSize) break;
      if (wantAll && items.length >= ALL_ITEMS_CAP) {
        hitCap = true;
        break;
      }
      // When the API's total is less than claimed empties, stop.
      if (!wantAll && items.length >= limit) break;
      if (total && offset >= total) break;
    }

    if (hitCap) {
      console.error(`Warning: --all stopped at ${ALL_ITEMS_CAP} items`);
    }

    return { items: items.slice(0, limit), total: total || items.length };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const result = await this.requestAllowEmpty<T>(method, path, body);
    if (result === null) {
      throw new CliError('API_ERROR', `Spotify returned an empty response for ${method} ${path}`);
    }
    return result;
  }

  private async requestAllowEmpty<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    return this.requestRaw(method, path, body !== undefined ? JSON.stringify(body) : undefined, {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }) as Promise<T | null>;
  }

  private async requestRaw(
    method: string,
    path: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    let attempt = 0;

    while (true) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.credentials.accessToken}`,
            ...extraHeaders,
          },
          body,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        throw new CliError('NETWORK_ERROR', `Could not reach Spotify: ${message}`);
      }

      if (response.status === 204 || response.status === 202) {
        return null;
      }

      if (response.status === 429) {
        const text = await response.text();
        if (/QUOTA_EXCEEDED/i.test(text)) {
          throw new CliError(
            'QUOTA_EXCEEDED',
            'Spotify API quota exceeded for this app',
            'Wait for the quota window to reset, or reduce request volume',
          );
        }
        if (attempt >= 3) {
          throw new CliError('RATE_LIMITED', 'Spotify rate limit exceeded after 3 retries');
        }
        const retryAfter = Number(response.headers.get('Retry-After') || '1');
        const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000;
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw this.mapError(response.status, text, method, path);
      }

      if (response.headers.get('Content-Type')?.includes('application/json')) {
        return response.json();
      }
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }

  private mapError(status: number, text: string, method: string, path: string): CliError {
    let reason = text;
    let spotifyReason: string | undefined;
    try {
      const parsed = JSON.parse(text);
      reason = parsed.error?.message || parsed.error_description || parsed.error || text;
      spotifyReason = parsed.error?.reason || parsed.error;
    } catch {
      // keep raw text
    }

    if (status === 403 && /PREMIUM_REQUIRED/i.test(text + (spotifyReason ?? ''))) {
      return new CliError(
        'PREMIUM_REQUIRED',
        'Playback control requires Spotify Premium',
        'Upgrade the account to Premium, or use read-only commands',
      );
    }

    if (status === 404 && /NO_ACTIVE_DEVICE/i.test(text + (spotifyReason ?? ''))) {
      return new CliError(
        'NO_ACTIVE_DEVICE',
        'No active Spotify device',
        'Open Spotify on a device, or pass --device',
      );
    }

    if (status === 403 && /not registered|user may not be registered|allowlist/i.test(reason)) {
      return new CliError(
        'PERMISSION_DENIED',
        'This Spotify user is not allowlisted for the app',
        'Add their email under User Management in the Spotify Developer Dashboard (max 5 users)',
      );
    }

    if (status === 403 && /playlist/i.test(path)) {
      return new CliError(
        'PERMISSION_DENIED',
        'Spotify only allows reading or changing playlists you own or collaborate on.',
        reason,
      );
    }

    return new CliError(
      httpStatusToErrorCode(status),
      `Spotify API error (${status} ${method} ${path}): ${reason}`,
    );
  }

  /** Used by player commands to enrich NO_ACTIVE_DEVICE errors. */
  async enrichNoActiveDevice(err: CliError): Promise<CliError> {
    if (err.code !== 'NO_ACTIVE_DEVICE') return err;
    try {
      const devices = await this.devices();
      return new CliError(
        'NO_ACTIVE_DEVICE',
        `No active Spotify device.\nAvailable devices:\n${formatDeviceList(devices)}`,
        'Pass --device <name|id>, or open Spotify on a phone/desktop/web player',
      );
    } catch {
      return err;
    }
  }
}
