import { writeJson } from '../../utils/output';
import type {
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
  SavedItem,
} from './types';
import { authExpiresAt } from './types';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function parseDuration(input: string): number {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const m = /^(\d+):(\d{1,2})$/.exec(trimmed);
  if (m) return (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) * 1000;
  throw new Error(`Invalid duration: ${input}`);
}

export interface OutputMode {
  json?: boolean;
  urisOnly?: boolean;
}

function emit(mode: OutputMode, data: unknown, text: () => void, uris?: string[]): void {
  if (mode.json) {
    writeJson(data, 2);
    return;
  }
  if (mode.urisOnly) {
    for (const uri of uris ?? []) console.log(uri);
    return;
  }
  text();
}

export function printAccount(user: SpotifyUser, credentials: SpotifyCredentials, mode: OutputMode = {}): void {
  const expires = authExpiresAt(credentials.authorizedAt).toISOString();
  const data = {
    id: user.id,
    displayName: user.displayName,
    uri: user.uri,
    url: user.externalUrl,
    scopes: credentials.scopes,
    readOnly: credentials.readOnly,
    authorizedAt: credentials.authorizedAt,
    signInExpiresAt: expires,
  };
  emit(mode, data, () => {
    console.log(`Display name: ${user.displayName}`);
    console.log(`User ID:      ${user.id}`);
    console.log(`URI:          ${user.uri}`);
    if (user.externalUrl) console.log(`URL:          ${user.externalUrl}`);
    console.log(`Read-only:    ${credentials.readOnly ? 'yes' : 'no'}`);
    console.log(`Scopes:       ${credentials.scopes.join(' ')}`);
    console.log(`Authorized:   ${credentials.authorizedAt}`);
    console.log(`Sign-in expires: ${expires}`);
  });
}

export function printTrack(track: SpotifyTrack, mode: OutputMode = {}, index?: number): void {
  const artists = track.artists.map((a) => a.name).join(', ');
  const album = track.album?.name ? ` · ${track.album.name}` : '';
  const prefix = index !== undefined ? `${String(index).padStart(2)}. ` : '';
  emit(mode, track, () => {
    console.log(`${prefix}${track.name} — ${artists}${album} · ${formatDuration(track.durationMs)}  ${track.uri}`);
  }, [track.uri]);
}

export function printTrackList(
  tracks: SpotifyTrack[],
  title: string,
  mode: OutputMode,
  total?: number,
  offset = 0,
): void {
  emit(mode, { title, total: total ?? tracks.length, items: tracks }, () => {
    if (title) console.log(title);
    tracks.forEach((t, i) => printTrack(t, {}, offset + i + 1));
    maybeMore(total, offset, tracks.length);
  }, tracks.map((t) => t.uri));
}

export function printArtistList(artists: SpotifyArtist[], title: string, mode: OutputMode, total?: number, offset = 0): void {
  emit(mode, { title, total: total ?? artists.length, items: artists }, () => {
    if (title) console.log(title);
    artists.forEach((a, i) => {
      const genres = a.genres?.length ? ` · ${a.genres.slice(0, 3).join(', ')}` : '';
      console.log(`${String(offset + i + 1).padStart(2)}. ${a.name}${genres}  ${a.uri}`);
    });
    maybeMore(total, offset, artists.length);
  }, artists.map((a) => a.uri));
}

export function printAlbumList(albums: SpotifyAlbum[], title: string, mode: OutputMode, total?: number, offset = 0): void {
  emit(mode, { title, total: total ?? albums.length, items: albums }, () => {
    if (title) console.log(title);
    albums.forEach((a, i) => {
      const artists = a.artists.map((x) => x.name).join(', ');
      const date = a.releaseDate ? ` · ${a.releaseDate}` : '';
      console.log(`${String(offset + i + 1).padStart(2)}. ${a.name} — ${artists}${date}  ${a.uri}`);
    });
    maybeMore(total, offset, albums.length);
  }, albums.map((a) => a.uri));
}

export function printPlaylistList(
  playlists: SpotifyPlaylist[],
  title: string,
  mode: OutputMode,
  total?: number,
  offset = 0,
): void {
  emit(mode, { title, total: total ?? playlists.length, items: playlists }, () => {
    if (title) console.log(title);
    playlists.forEach((p, i) => {
      const vis = p.collaborative ? 'collaborative' : p.public ? 'public' : 'private';
      const count = p.totalItems !== undefined ? `${p.totalItems} items` : '';
      console.log(
        `${String(offset + i + 1).padStart(2)}. ${p.name} — ${count} (owner: ${p.ownerName || p.ownerId || '?'}, ${vis})  ${p.uri}`,
      );
    });
    maybeMore(total, offset, playlists.length);
  }, playlists.map((p) => p.uri));
}

export function printPlaylistItems(
  playlist: SpotifyPlaylist,
  items: SpotifyPlaylistItem[],
  mode: OutputMode,
  total?: number,
  offset = 0,
): void {
  const uris = items.map((it) => it.uri || it.track?.uri || it.episode?.uri).filter(Boolean) as string[];
  emit(mode, { playlist, total: total ?? items.length, items }, () => {
    const vis = playlist.collaborative ? 'collaborative' : playlist.public ? 'public' : 'private';
    console.log(
      `${playlist.name} — ${total ?? items.length} items (owner: ${playlist.ownerName || playlist.ownerId || '?'}, ${vis}) ${playlist.uri}`,
    );
    items.forEach((it, i) => {
      const n = String(offset + i + 1).padStart(2);
      if (it.track) {
        const artists = it.track.artists.map((a) => a.name).join(', ');
        const album = it.track.album?.name ? ` · ${it.track.album.name}` : '';
        console.log(` ${n}. ${it.track.name} — ${artists}${album} · ${formatDuration(it.track.durationMs)}  ${it.track.uri}`);
      } else if (it.episode) {
        console.log(` ${n}. ${it.episode.name} · ${formatDuration(it.episode.durationMs)}  ${it.episode.uri}`);
      } else {
        console.log(` ${n}. (unavailable item)`);
      }
    });
    maybeMore(total, offset, items.length);
  }, uris);
}

export function printShowList(shows: SpotifyShow[], title: string, mode: OutputMode, total?: number, offset = 0): void {
  emit(mode, { title, total: total ?? shows.length, items: shows }, () => {
    if (title) console.log(title);
    shows.forEach((s, i) => {
      console.log(`${String(offset + i + 1).padStart(2)}. ${s.name} — ${s.publisher || ''}  ${s.uri}`);
    });
    maybeMore(total, offset, shows.length);
  }, shows.map((s) => s.uri));
}

export function printEpisodeList(episodes: SpotifyEpisode[], title: string, mode: OutputMode, total?: number, offset = 0): void {
  emit(mode, { title, total: total ?? episodes.length, items: episodes }, () => {
    if (title) console.log(title);
    episodes.forEach((e, i) => {
      const resume = e.resumePoint?.resumePositionMs
        ? ` (resume ${formatDuration(e.resumePoint.resumePositionMs)})`
        : '';
      console.log(`${String(offset + i + 1).padStart(2)}. ${e.name} · ${formatDuration(e.durationMs)}${resume}  ${e.uri}`);
    });
    maybeMore(total, offset, episodes.length);
  }, episodes.map((e) => e.uri));
}

export function printChapterList(chapters: SpotifyChapter[], title: string, mode: OutputMode, total?: number, offset = 0): void {
  emit(mode, { title, total: total ?? chapters.length, items: chapters }, () => {
    if (title) console.log(title);
    chapters.forEach((c, i) => {
      console.log(`${String(offset + i + 1).padStart(2)}. ${c.name} · ${formatDuration(c.durationMs)}  ${c.uri}`);
    });
    maybeMore(total, offset, chapters.length);
  }, chapters.map((c) => c.uri));
}

export function printAudiobookList(books: SpotifyAudiobook[], title: string, mode: OutputMode, total?: number, offset = 0): void {
  emit(mode, { title, total: total ?? books.length, items: books }, () => {
    if (title) console.log(title);
    books.forEach((b, i) => {
      const authors = (b.authors ?? []).map((a) => a.name).join(', ');
      console.log(`${String(offset + i + 1).padStart(2)}. ${b.name} — ${authors}  ${b.uri}`);
    });
    maybeMore(total, offset, books.length);
  }, books.map((b) => b.uri));
}

export function printSavedTracks(items: SavedItem<SpotifyTrack>[], mode: OutputMode, total?: number, offset = 0): void {
  emit(mode, { total: total ?? items.length, items }, () => {
    items.forEach((s, i) => {
      const t = s.item;
      const artists = t.artists.map((a) => a.name).join(', ');
      console.log(`${String(offset + i + 1).padStart(2)}. [${s.addedAt}] ${t.name} — ${artists}  ${t.uri}`);
    });
    maybeMore(total, offset, items.length);
  }, items.map((s) => s.item.uri));
}

export function printHistory(items: SpotifyRecentPlay[], mode: OutputMode): void {
  emit(mode, { items }, () => {
    items.forEach((h, i) => {
      const t = h.track;
      const artists = t.artists.map((a) => a.name).join(', ');
      console.log(`${String(i + 1).padStart(2)}. [${h.playedAt}] ${t.name} — ${artists}  ${t.uri}`);
    });
  }, items.map((h) => h.track.uri));
}

export function printDevices(devices: SpotifyDevice[], mode: OutputMode): void {
  emit(mode, { devices }, () => {
    if (devices.length === 0) {
      console.log('No devices. Open Spotify on a phone, desktop, or web player.');
      return;
    }
    for (const d of devices) {
      const active = d.isActive ? ' [active]' : '';
      const vol = d.volumePercent !== null ? ` vol=${d.volumePercent}` : '';
      console.log(`${d.name} (${d.type}) id=${d.id ?? '?'}${active}${vol}`);
    }
  }, devices.map((d) => d.id).filter(Boolean) as string[]);
}

export function printPlayerStatus(state: SpotifyPlaybackState | null, mode: OutputMode): void {
  if (!state) {
    emit(mode, { playing: false }, () => console.log('Nothing playing'));
    return;
  }
  emit(mode, state, () => {
    const item = state.item;
    const name = item ? ('artists' in item
      ? `${item.name} — ${item.artists.map((a) => a.name).join(', ')}`
      : item.name) : '(unknown)';
    const uri = item?.uri ?? '';
    const progress = state.progressMs !== null && item && 'durationMs' in item
      ? `${formatDuration(state.progressMs)} / ${formatDuration(item.durationMs)}`
      : '';
    console.log(`${state.isPlaying ? 'Playing' : 'Paused'}: ${name}  ${uri}`);
    if (progress) console.log(`Progress: ${progress}`);
    if (state.device) console.log(`Device:   ${state.device.name} (${state.device.type}) id=${state.device.id ?? '?'}`);
    console.log(`Shuffle:  ${state.shuffleState ? 'on' : 'off'}   Repeat: ${state.repeatState}`);
    if (state.context?.uri) console.log(`Context:  ${state.context.uri}`);
  }, state.item?.uri ? [state.item.uri] : []);
}

export function printQueue(queue: SpotifyQueue, mode: OutputMode): void {
  emit(mode, queue, () => {
    if (queue.currentlyPlaying) {
      console.log('Now:');
      const item = queue.currentlyPlaying;
      if ('artists' in item) {
        console.log(`  ${item.name} — ${item.artists.map((a) => a.name).join(', ')}  ${item.uri}`);
      } else {
        console.log(`  ${item.name}  ${item.uri}`);
      }
    }
    console.log('Queue:');
    queue.queue.forEach((item, i) => {
      if ('artists' in item) {
        console.log(` ${String(i + 1).padStart(2)}. ${item.name} — ${item.artists.map((a) => a.name).join(', ')}  ${item.uri}`);
      } else {
        console.log(` ${String(i + 1).padStart(2)}. ${item.name}  ${item.uri}`);
      }
    });
  }, [
    ...(queue.currentlyPlaying?.uri ? [queue.currentlyPlaying.uri] : []),
    ...queue.queue.map((q) => q.uri),
  ]);
}

export function printGet(type: string, item: unknown, mode: OutputMode): void {
  emit(mode, item, () => {
    switch (type) {
      case 'track': printTrack(item as SpotifyTrack); break;
      case 'album': {
        const a = item as SpotifyAlbum;
        console.log(`${a.name} — ${a.artists.map((x) => x.name).join(', ')} (${a.releaseDate || '?'})  ${a.uri}`);
        if (a.totalTracks !== undefined) console.log(`Tracks: ${a.totalTracks}`);
        break;
      }
      case 'artist': {
        const a = item as SpotifyArtist;
        console.log(`${a.name}  ${a.uri}`);
        if (a.genres?.length) console.log(`Genres: ${a.genres.join(', ')}`);
        break;
      }
      case 'playlist': {
        const p = item as SpotifyPlaylist;
        console.log(`${p.name}  ${p.uri}`);
        console.log(`Owner: ${p.ownerName || p.ownerId || '?'}`);
        console.log(`Public: ${p.public ? 'yes' : 'no'}  Collaborative: ${p.collaborative ? 'yes' : 'no'}`);
        if (p.snapshotId) console.log(`Snapshot: ${p.snapshotId}`);
        if (p.description) console.log(p.description);
        console.log('(use: agentio spotify playlist items … for contents)');
        break;
      }
      case 'show': {
        const s = item as SpotifyShow;
        console.log(`${s.name} — ${s.publisher || ''}  ${s.uri}`);
        break;
      }
      case 'episode': {
        const e = item as SpotifyEpisode;
        console.log(`${e.name} · ${formatDuration(e.durationMs)}  ${e.uri}`);
        break;
      }
      case 'audiobook': {
        const b = item as SpotifyAudiobook;
        console.log(`${b.name}  ${b.uri}`);
        break;
      }
      case 'chapter': {
        const c = item as SpotifyChapter;
        console.log(`${c.name} · ${formatDuration(c.durationMs)}  ${c.uri}`);
        break;
      }
      default:
        console.log(JSON.stringify(item, null, 2));
    }
  }, [(item as { uri?: string }).uri].filter(Boolean) as string[]);
}

function maybeMore(total: number | undefined, offset: number, shown: number): void {
  if (total === undefined) return;
  const remaining = total - offset - shown;
  if (remaining > 0) {
    console.log(`(${remaining} more — use --all or --offset ${offset + shown})`);
  }
}
