import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import { createProfileCommands } from '../../utils/profile-commands';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { confirm, readStdin } from '../../utils/stdin';
import { addExamples, getExamples } from '../../utils/command-tree';
import { addJsonOption, isJsonMode } from '../../utils/output';
import type { SetupContext, SetupResult } from '../../plugin-sdk';
import { checkAnswer } from '../setup-inputs';
import { SpotifyClient } from './client';
import { parseSpotifyRef, resolveDevice, resolvePlaylistRef, foldName } from './ids';
import { authorizeSpotify, SPOTIFY_APP_SETUP_STEPS } from './oauth';
import { SPOTIFY_CLIENT_ID_INPUT } from './setup-needs';
import {
  formatDuration,
  parseDuration,
  printAccount,
  printAlbumList,
  printArtistList,
  printAudiobookList,
  printChapterList,
  printDevices,
  printEpisodeList,
  printGet,
  printHistory,
  printPlayerStatus,
  printPlaylistItems,
  printPlaylistList,
  printQueue,
  printSavedTracks,
  printShowList,
  printTrackList,
  type OutputMode,
} from './output';
import type { PageOptions, SpotifyCredentials, SpotifyItemType, SpotifyPlaylist, SpotifyTrack } from './types';

const getSpotifyClient = createClientGetter<SpotifyCredentials, SpotifyClient>({
  service: 'spotify',
  createClient: (credentials) => new SpotifyClient(credentials),
});

function modeOf(options: { json?: boolean; urisOnly?: boolean }): OutputMode {
  return { json: !!options.json, urisOnly: !!options.urisOnly };
}

function pageOf(options: { limit?: string; offset?: string; all?: boolean }): PageOptions {
  return {
    limit: options.limit !== undefined ? parsePositiveInt(options.limit, '--limit') : undefined,
    offset: options.offset !== undefined ? parseNonNegInt(options.offset, '--offset') : undefined,
    all: !!options.all,
  };
}

function parsePositiveInt(value: string, flag: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1) throw new CliError('INVALID_PARAMS', `${flag} must be a positive number`);
  return n;
}

function parseNonNegInt(value: string, flag: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) throw new CliError('INVALID_PARAMS', `${flag} must be a non-negative number`);
  return n;
}

function addPagingOptions(cmd: Command): Command {
  return cmd
    .option('--limit <n>', 'Maximum items to return')
    .option('--offset <n>', 'Number of items to skip', '0')
    .option('--all', `Fetch all pages (hard cap 10000)`);
}

function addOutputOptions(cmd: Command): Command {
  addJsonOption(cmd);
  return cmd.option('--uris-only', 'Print one Spotify URI per line');
}

function addProfileOption(cmd: Command): Command {
  return cmd.option('--profile <name>', 'Profile name (optional if only one profile exists)');
}

async function resolveItemArgs(args: string[], expected?: SpotifyItemType | SpotifyItemType[]): Promise<string[]> {
  let lines = args;
  if (args.length === 1 && args[0] === '-') {
    const text = await readStdin();
    if (!text) {
      throw new CliError('INVALID_PARAMS', 'No items on stdin', 'Pipe URIs, one per line');
    }
    lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  return lines.map((line) => parseSpotifyRef(line, expected).uri);
}

async function enforceWritable(client: SpotifyClient, operation: string): Promise<void> {
  if (client.getCredentials().readOnly) {
    throw new CliError(
      'READ_ONLY_PROFILE',
      `Cannot ${operation}: this Spotify profile is read-only`,
      'Re-add the profile without --read-only to grant write and playback scopes',
    );
  }
}

async function resolvePlaylist(client: SpotifyClient, input: string): Promise<SpotifyPlaylist> {
  // Prefer structured IDs without fetching the full list.
  if (
    input.startsWith('spotify:')
    || input.startsWith('http://')
    || input.startsWith('https://')
  ) {
    const ref = parseSpotifyRef(input, 'playlist');
    try {
      return await client.getPlaylist(ref.id);
    } catch {
      return { id: ref.id, name: ref.id, uri: ref.uri };
    }
  }
  // Bare ID-looking token: try as ID first, then name.
  if (/^[0-9A-Za-z]{14,128}$/.test(input.trim())) {
    try {
      return await client.getPlaylist(input.trim());
    } catch {
      // fall through to name match
    }
  }
  const playlists = await client.allPlaylists();
  return resolvePlaylistRef(input, playlists);
}

function parseRelativeOrIsoTime(input: string): number {
  const trimmed = input.trim();
  const rel = /^(\d+)([smhdw])$/i.exec(trimmed);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const mult: Record<string, number> = {
      s: 1000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return Date.now() - n * mult[rel[2].toLowerCase()];
  }
  const ms = Date.parse(trimmed);
  if (isNaN(ms)) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid time: ${input}`,
      'Use ISO 8601 (2026-01-01T00:00:00Z) or a relative value like 2h, 1d',
    );
  }
  return ms;
}

async function withPlayerError<T>(client: SpotifyClient, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CliError && err.code === 'NO_ACTIVE_DEVICE') {
      throw await client.enrichNoActiveDevice(err);
    }
    throw err;
  }
}


const SPOTIFY_LEAF_EXAMPLES: Record<string, string> = {
  'spotify album tracks': `Examples:

  agentio spotify album tracks spotify:album:5ZWan77O9yRz3v3YdZbV7A`,
  'spotify show episodes': `Examples:

  agentio spotify show episodes spotify:show:4rOoJ6Egrf8K2IrywzwOMk`,
  'spotify audiobook chapters': `Examples:

  agentio spotify audiobook chapters <audiobook-uri>`,
  'spotify playlist list': `Examples:

  agentio spotify playlist list
  agentio spotify playlist list --owned --uris-only`,
  'spotify playlist find': `Examples:

  agentio spotify playlist find "road trip"`,
  'spotify playlist get': `Examples:

  agentio spotify playlist get "Road trip"`,
  'spotify playlist items': `Examples:

  agentio spotify playlist items "Road trip" --limit 20
  agentio spotify playlist items <playlist-uri> --all`,
  'spotify playlist create': `Examples:

  agentio spotify playlist create "Road trip" --description "car songs"
  agentio spotify playlist create "Collab" --collaborative`,
  'spotify playlist update': `Examples:

  agentio spotify playlist update "Road trip" --name "Road Trip 2026" --public`,
  'spotify playlist add': `Examples:

  agentio spotify playlist add "Road trip" spotify:track:4uLU6hMCjMI75M1A2tKUQC
  agentio spotify search "radiohead" --uris-only | agentio spotify playlist add "90s" -`,
  'spotify playlist remove': `Examples:

  agentio spotify playlist remove "Road trip" spotify:track:4uLU6hMCjMI75M1A2tKUQC`,
  'spotify playlist reorder': `Examples:

  agentio spotify playlist reorder "Road trip" --from 5 --to 1`,
  'spotify playlist replace': `Examples:

  agentio spotify playlist replace "Road trip" - --yes < uris.txt`,
  'spotify playlist dedupe': `Examples:

  agentio spotify playlist dedupe "Road trip"
  agentio spotify playlist dedupe "Road trip" --dry-run`,
  'spotify playlist cover': `Examples:

  agentio spotify playlist cover "Road trip"
  agentio spotify playlist cover "Road trip" --set cover.jpg`,
  'spotify playlist delete': `Examples:

  agentio spotify playlist delete "Old mix" --yes`,
  'spotify playlist export': `Examples:

  agentio spotify playlist export "Road trip" --format m3u
  agentio spotify playlist export "Road trip" --format csv`,
  'spotify library list': `Examples:

  agentio spotify library list
  agentio spotify library list --type artists --all`,
  'spotify library search': `Examples:

  agentio spotify library search "karma" --type tracks,albums
  agentio spotify library search "radiohead" --in-playlists`,
  'spotify library save': `Examples:

  agentio spotify library save spotify:track:4uLU6hMCjMI75M1A2tKUQC
  agentio spotify library save - < uris.txt`,
  'spotify library remove': `Examples:

  agentio spotify library remove spotify:album:5ZWan77O9yRz3v3YdZbV7A`,
  'spotify library contains': `Examples:

  agentio spotify library contains spotify:track:4uLU6hMCjMI75M1A2tKUQC`,
  'spotify top tracks': `Examples:

  agentio spotify top tracks --range short
  agentio spotify top tracks --range long --limit 20`,
  'spotify top artists': `Examples:

  agentio spotify top artists --range medium`,
  'spotify player status': `Examples:

  agentio spotify player status`,
  'spotify player devices': `Examples:

  agentio spotify player devices`,
  'spotify player play': `Examples:

  agentio spotify player play
  agentio spotify player play spotify:track:4uLU6hMCjMI75M1A2tKUQC --device Phone
  agentio spotify player play --context spotify:playlist:37i9dQZF1DXcBWIGoYBM5M`,
  'spotify player pause': `Examples:

  agentio spotify player pause --device Phone`,
  'spotify player next': `Examples:

  agentio spotify player next`,
  'spotify player previous': `Examples:

  agentio spotify player previous`,
  'spotify player seek': `Examples:

  agentio spotify player seek 1:30
  agentio spotify player seek 90000`,
  'spotify player volume': `Examples:

  agentio spotify player volume 50`,
  'spotify player shuffle': `Examples:

  agentio spotify player shuffle on
  agentio spotify player shuffle off`,
  'spotify player repeat': `Examples:

  agentio spotify player repeat context
  agentio spotify player repeat off`,
  'spotify player queue': `Examples:

  agentio spotify player queue`,
  'spotify player queue add': `Examples:

  agentio spotify player queue add spotify:track:4uLU6hMCjMI75M1A2tKUQC`,
  'spotify player transfer': `Examples:

  agentio spotify player transfer Phone --play`,
};

function attachMissingExamples(root: Command, prefix: string): void {
  function walk(cmd: Command, parts: string[]): void {
    const path = parts.length ? `${parts.join(' ')} ${cmd.name()}` : cmd.name();
    // Attach when this node is a runnable leaf OR has its own action alongside children
    // (e.g. `player queue` lists the queue and also has `queue add`).
    const isRunnable = cmd.commands.length === 0 || typeof (cmd as Command & { _actionHandler?: unknown })._actionHandler === 'function';
    if (isRunnable && !getExamples(cmd)) {
      const text = SPOTIFY_LEAF_EXAMPLES[path];
      if (text) addExamples(cmd, text);
    }
    for (const child of cmd.commands) walk(child, parts.concat(cmd.name()));
  }
  walk(root, prefix ? [prefix] : []);
}

export function registerSpotifyCommands(program: Command): void {
  const spotify = program.command('spotify').description('Spotify Web API operations');

  // ---- account ----
  addExamples(
    addOutputOptions(addProfileOption(
      spotify.command('account').description('Show the connected Spotify account'),
    )).action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const me = await client.me();
        printAccount(me, client.getCredentials(), modeOf(options));
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio spotify account
  agentio spotify account --json`,
  );

  // ---- search ----
  {
    const cmd = spotify.command('search').description('Search the Spotify catalog');
    addPagingOptions(cmd);
    addOutputOptions(cmd);
    addProfileOption(cmd);
    addExamples(
      cmd
        .argument('<query>', 'Search query (supports artist:, album:, year:, genre:, …)')
        .option('--type <types>', 'Comma-separated: track,album,artist,playlist,show,episode,audiobook', 'track')
        .option('--market <CC>', 'ISO country code market')
        .action(async (query: string, options) => {
          try {
            const { client } = await getSpotifyClient(options.profile);
            const types = String(options.type).split(',').map((t: string) => t.trim()).filter(Boolean);
            const page = pageOf(options);
            const results = await client.search({
              query,
              types,
              limit: page.limit ?? 10,
              offset: page.offset ?? 0,
              market: options.market,
            });
            const mode = modeOf(options);
            if (mode.json) {
              const { writeJson } = await import('../../utils/output');
              writeJson({ query, results }, 2);
              return;
            }
            for (const group of results) {
              if (group.type === 'track') printTrackList(group.items as SpotifyTrack[], `Tracks`, mode);
              else if (group.type === 'album') printAlbumList(group.items as any, 'Albums', mode);
              else if (group.type === 'artist') printArtistList(group.items as any, 'Artists', mode);
              else if (group.type === 'playlist') printPlaylistList(group.items as any, 'Playlists', mode);
              else if (group.type === 'show') printShowList(group.items as any, 'Shows', mode);
              else if (group.type === 'episode') printEpisodeList(group.items as any, 'Episodes', mode);
              else if (group.type === 'audiobook') printAudiobookList(group.items as any, 'Audiobooks', mode);
            }
          } catch (error) {
            handleError(error);
          }
        }),
      `Examples:

  agentio spotify search "artist:Radiohead year:1997" --type track
  agentio spotify search "ok computer" --type album,track --limit 20

Query filters: artist:, album:, track:, year:1990-1999, genre:, isrc:, upc:, tag:new, tag:hipster.
--limit defaults to 10 (max 50, fetched in pages of 10). Offset + limit cannot exceed 1000.`,
    );
  }

  // ---- get ----
  addExamples(
    addOutputOptions(addProfileOption(
      spotify.command('get')
        .description('Look up a catalog item by URI, URL, or ID')
        .argument('<uri-or-url>', 'Spotify URI, open.spotify.com URL, or bare ID with --type')
        .option('--type <type>', 'Required for bare IDs: track|album|artist|playlist|show|episode|audiobook|chapter'),
    )).action(async (input: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const expected = options.type as SpotifyItemType | undefined;
        const ref = parseSpotifyRef(input, expected);
        if (ref.type === 'local') {
          throw new CliError('INVALID_PARAMS', 'Local Spotify tracks cannot be fetched from the Web API');
        }
        const item = await client.get(ref.type, ref.id);
        printGet(ref.type, item, modeOf(options));
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio spotify get spotify:track:4uLU6hMCjMI75M1A2tKUQC
  agentio spotify get https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=abc
  agentio spotify get 4uLU6hMCjMI75M1A2tKUQC --type track`,
  );

  // ---- album / artist / show / audiobook ----
  {
    const album = spotify.command('album').description('Album helpers');
    const tracksCmd = album.command('tracks').description('List an album\'s tracks')
      .argument('<album>', 'Album URI, URL, ID, or name-not-supported');
    addPagingOptions(tracksCmd);
    addOutputOptions(tracksCmd);
    addProfileOption(tracksCmd);
    tracksCmd.action(async (album: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const ref = parseSpotifyRef(album, 'album');
        const page = pageOf(options);
        const { items, total } = await client.albumTracks(ref.id, page);
        printTrackList(items, `Album tracks`, modeOf(options), total, page.offset ?? 0);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const artist = spotify.command('artist').description('Artist helpers (top tracks were removed by Spotify)');
    const albumsCmd = artist.command('albums').description('List an artist\'s albums')
      .argument('<artist>', 'Artist URI, URL, or ID')
      .option('--include <groups>', 'Comma-separated: album,single,appears_on,compilation');
    addPagingOptions(albumsCmd);
    addOutputOptions(albumsCmd);
    addProfileOption(albumsCmd);
    addExamples(
      albumsCmd.action(async (artist: string, options) => {
        try {
          const { client } = await getSpotifyClient(options.profile);
          const ref = parseSpotifyRef(artist, 'artist');
          const page = pageOf(options);
          const include = options.include
            ? String(options.include).split(',').map((s: string) => s.trim()).filter(Boolean)
            : undefined;
          const { items, total } = await client.artistAlbums(ref.id, { ...page, include });
          printAlbumList(items, 'Artist albums', modeOf(options), total, page.offset ?? 0);
        } catch (error) {
          handleError(error);
        }
      }),
      `Examples:

  agentio spotify artist albums spotify:artist:4Z8W4fKeB5YxbusRsdQVPb
  agentio spotify artist albums <artist-id> --include album,single

Artist top tracks were removed from the Spotify Web API (November 2024).`,
    );
  }

  {
    const show = spotify.command('show').description('Podcast show helpers');
    const epCmd = show.command('episodes').description('List a show\'s episodes')
      .argument('<show>', 'Show URI, URL, or ID');
    addPagingOptions(epCmd);
    addOutputOptions(epCmd);
    addProfileOption(epCmd);
    epCmd.action(async (show: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const ref = parseSpotifyRef(show, 'show');
        const page = pageOf(options);
        const { items, total } = await client.showEpisodes(ref.id, page);
        printEpisodeList(items, 'Episodes', modeOf(options), total, page.offset ?? 0);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const audiobook = spotify.command('audiobook').description('Audiobook helpers');
    const chCmd = audiobook.command('chapters').description('List an audiobook\'s chapters')
      .argument('<audiobook>', 'Audiobook URI, URL, or ID');
    addPagingOptions(chCmd);
    addOutputOptions(chCmd);
    addProfileOption(chCmd);
    chCmd.action(async (audiobook: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const ref = parseSpotifyRef(audiobook, 'audiobook');
        const page = pageOf(options);
        const { items, total } = await client.audiobookChapters(ref.id, page);
        printChapterList(items, 'Chapters', modeOf(options), total, page.offset ?? 0);
      } catch (error) {
        handleError(error);
      }
    });
  }

  registerPlaylistCommands(spotify);
  registerLibraryCommands(spotify);
  registerHistoryCommands(spotify);
  registerPlayerCommands(spotify);
  registerProfileCommands(spotify);
  attachMissingExamples(spotify, '');
}

function registerPlaylistCommands(spotify: Command): void {
  const playlist = spotify.command('playlist').description('Manage playlists');

  {
    const cmd = playlist.command('list').description('List the user\'s playlists')
      .option('--owned', 'Only playlists the user owns')
      .option('--collaborative', 'Only collaborative playlists');
    addPagingOptions(cmd);
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const page = pageOf(options);
        const me = await client.me();
        let { items, total } = await client.listPlaylists(page);
        if (options.owned) items = items.filter((p) => p.ownerId === me.id);
        if (options.collaborative) items = items.filter((p) => p.collaborative);
        printPlaylistList(items, 'Playlists', modeOf(options), total, page.offset ?? 0);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('find').description('Find playlists by name or description (fetches all pages; may use many requests)')
      .argument('<text>', 'Case-insensitive text to match');
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (text: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        console.error('Fetching playlists…');
        const all = await client.allPlaylists();
        const needle = foldName(text);
        const matches = all.filter(
          (p) => foldName(p.name).includes(needle) || foldName(p.description || '').includes(needle),
        );
        printPlaylistList(matches, `Playlists matching "${text}"`, modeOf(options));
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('get').description('Show playlist details (without items)')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name');
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (input: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const pl = await resolvePlaylist(client, input);
        const full = await client.getPlaylist(pl.id);
        printGet('playlist', full, modeOf(options));
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('items').description('List playlist items (owned/collaborative only)')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name');
    addPagingOptions(cmd);
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (input: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const pl = await resolvePlaylist(client, input);
        const page = pageOf(options);
        const { items, total } = await client.playlistItems(pl.id, page);
        const meta = await client.getPlaylist(pl.id).catch(() => pl);
        printPlaylistItems(meta, items, modeOf(options), total, page.offset ?? 0);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('create').description('Create a playlist (private by default)')
      .argument('<name>', 'Playlist name')
      .option('--description <text>', 'Description')
      .option('--public', 'Make the playlist public')
      .option('--collaborative', 'Make collaborative (implies private)');
    addProfileOption(cmd);
    cmd.action(async (name: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'create a playlist');
        const pl = await client.createPlaylist({
          name,
          description: options.description,
          isPublic: !!options.public,
          collaborative: !!options.collaborative,
        });
        console.log(`Created ${pl.name}  ${pl.uri}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('update').description('Update playlist details')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .option('--name <name>', 'New name')
      .option('--description <text>', 'New description')
      .option('--public', 'Make public')
      .option('--private', 'Make private')
      .option('--collaborative', 'Enable collaborative')
      .option('--no-collaborative', 'Disable collaborative');
    addProfileOption(cmd);
    cmd.action(async (input: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'update a playlist');
        const pl = await resolvePlaylist(client, input);
        let isPublic: boolean | undefined;
        if (options.public) isPublic = true;
        if (options.private) isPublic = false;
        let collaborative: boolean | undefined;
        if (options.collaborative === true) collaborative = true;
        if (options.collaborative === false) collaborative = false;
        await client.updatePlaylist(pl.id, {
          name: options.name,
          description: options.description,
          isPublic,
          collaborative,
        });
        console.log(`Updated ${pl.uri}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('add').description('Add tracks/episodes to a playlist')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .argument('<items...>', 'URIs/URLs/IDs, or - to read from stdin')
      .option('--position <n>', '1-based insert position')
      .option('--skip-duplicates', 'Skip URIs already in the playlist');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'add playlist items');
        const pl = await resolvePlaylist(client, playlist);
        let uris = await resolveItemArgs(items, ['track', 'episode']);
        if (options.skipDuplicates) {
          const { items: existing } = await client.playlistItems(pl.id, { all: true });
          const have = new Set(existing.map((it) => it.uri).filter(Boolean));
          uris = uris.filter((u) => !have.has(u));
        }
        if (uris.length === 0) {
          console.log('Nothing to add');
          return;
        }
        const position = options.position !== undefined
          ? parsePositiveInt(options.position, '--position') - 1
          : undefined;
        const result = await client.addPlaylistItems(pl.id, uris, { position });
        console.log(`Added ${result.added} item(s). snapshot_id=${result.snapshotId}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('remove').description('Remove tracks/episodes from a playlist')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .argument('<items...>', 'URIs/URLs/IDs, or - to read from stdin')
      .option('--snapshot <id>', 'Playlist snapshot_id');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'remove playlist items');
        const pl = await resolvePlaylist(client, playlist);
        const uris = await resolveItemArgs(items, ['track', 'episode']);
        const result = await client.removePlaylistItems(pl.id, uris, options.snapshot);
        console.log(`Removed ${result.removed} item(s). snapshot_id=${result.snapshotId}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('reorder').description('Reorder playlist items (1-based positions)')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .requiredOption('--from <index>', '1-based start index')
      .requiredOption('--to <index>', '1-based destination index')
      .option('--count <n>', 'Number of items to move', '1')
      .option('--snapshot <id>', 'Playlist snapshot_id');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'reorder playlist items');
        const pl = await resolvePlaylist(client, playlist);
        const from = parsePositiveInt(options.from, '--from') - 1;
        const to = parsePositiveInt(options.to, '--to') - 1;
        const count = parsePositiveInt(options.count, '--count');
        const snapshotId = await client.reorderPlaylistItems(pl.id, {
          rangeStart: from,
          insertBefore: to,
          rangeLength: count,
          snapshotId: options.snapshot,
        });
        console.log(`Reordered. snapshot_id=${snapshotId}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('replace').description('Replace all playlist items')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .argument('<items...>', 'URIs/URLs/IDs, or - to read from stdin')
      .option('--yes', 'Skip confirmation');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'replace playlist items');
        const pl = await resolvePlaylist(client, playlist);
        const uris = await resolveItemArgs(items, ['track', 'episode']);
        if (!options.yes) {
          const ok = await confirm(`Replace all items in "${pl.name}" with ${uris.length} URI(s)?`);
          if (!ok) {
            console.error('Cancelled');
            return;
          }
        }
        const snapshotId = await client.replacePlaylistItems(pl.id, uris);
        console.log(`Replaced with ${uris.length} item(s). snapshot_id=${snapshotId}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('dedupe').description('Remove duplicate URIs, keeping the first copy')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .option('--dry-run', 'Show duplicates without removing them');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'dedupe a playlist');
        const pl = await resolvePlaylist(client, playlist);
        const { items } = await client.playlistItems(pl.id, { all: true });
        const seen = new Set<string>();
        const dupes: string[] = [];
        for (const it of items) {
          const uri = it.uri;
          if (!uri) continue;
          if (seen.has(uri)) dupes.push(uri);
          else seen.add(uri);
        }
        if (dupes.length === 0) {
          console.log('No duplicates');
          return;
        }
        console.error(`Found ${dupes.length} duplicate(s)`);
        if (options.dryRun) {
          for (const u of dupes) console.log(u);
          return;
        }
        const result = await client.removePlaylistItems(pl.id, dupes);
        console.log(`Removed ${result.removed} duplicate(s). snapshot_id=${result.snapshotId}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('cover').description('Get or set the playlist cover image')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .option('--set <file.jpg>', 'Upload a JPEG cover (max 256 KB)')
      .option('--output <file>', 'Download the current cover to this path');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const pl = await resolvePlaylist(client, playlist);
        if (options.set) {
          await enforceWritable(client, 'set playlist cover');
          const buf = await readFile(options.set);
          if (buf.byteLength > 256 * 1024) {
            throw new CliError('INVALID_PARAMS', 'Cover JPEG must be at most 256 KB');
          }
          await client.setPlaylistCover(pl.id, buf.toString('base64'));
          console.log(`Cover updated for ${pl.uri}`);
          return;
        }
        const images = await client.getPlaylistCover(pl.id);
        if (options.output) {
          if (!images[0]?.url) throw new CliError('NOT_FOUND', 'Playlist has no cover image');
          const res = await fetch(images[0].url);
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(options.output, buf);
          console.error(`Wrote ${options.output} (${buf.byteLength} bytes)`);
          return;
        }
        for (const img of images) {
          console.log(`${img.width ?? '?'}x${img.height ?? '?'}  ${img.url}`);
        }
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('delete').description('Unfollow a playlist (Spotify has no real delete)')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .option('--yes', 'Skip confirmation');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'delete (unfollow) a playlist');
        const pl = await resolvePlaylist(client, playlist);
        if (!options.yes) {
          const ok = await confirm(`Unfollow playlist "${pl.name}"? (Spotify cannot truly delete playlists)`);
          if (!ok) {
            console.error('Cancelled');
            return;
          }
        }
        await client.libraryRemove([pl.uri]);
        console.log(`Unfollowed ${pl.uri} (Spotify has no real delete — the playlist was removed from your library)`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = playlist.command('export').description('Export playlist items')
      .argument('<playlist>', 'Playlist URI, URL, ID, or name')
      .option('--format <fmt>', 'csv, json, or m3u', 'json');
    addProfileOption(cmd);
    cmd.action(async (playlist: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const pl = await resolvePlaylist(client, playlist);
        const { items } = await client.playlistItems(pl.id, { all: true });
        const fmt = String(options.format).toLowerCase();
        if (fmt === 'json') {
          const { writeJson } = await import('../../utils/output');
          writeJson({ playlist: pl, items }, 2);
        } else if (fmt === 'csv') {
          console.log('uri,name,artists,album,duration_ms');
          for (const it of items) {
            const t = it.track;
            if (!t) continue;
            const artists = t.artists.map((a) => a.name).join('; ');
            console.log(`"${t.uri}","${t.name.replace(/"/g, '""')}","${artists.replace(/"/g, '""')}","${(t.album?.name || '').replace(/"/g, '""')}",${t.durationMs}`);
          }
        } else if (fmt === 'm3u') {
          console.log('#EXTM3U');
          for (const it of items) {
            const t = it.track;
            if (!t) continue;
            console.log(`#EXTINF:${Math.round(t.durationMs / 1000)},${t.artists.map((a) => a.name).join(', ')} - ${t.name}`);
            console.log(t.uri);
          }
        } else {
          throw new CliError('INVALID_PARAMS', `Unknown format: ${fmt}`, 'Use csv, json, or m3u');
        }
      } catch (error) {
        handleError(error);
      }
    });
  }
}

function registerLibraryCommands(spotify: Command): void {
  const library = spotify.command('library').description('Saved and followed library items');

  {
    const cmd = library.command('list').description('List saved/followed items')
      .option('--type <type>', 'tracks|albums|shows|episodes|audiobooks|artists|playlists', 'tracks');
    addPagingOptions(cmd);
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const page = pageOf(options);
        const type = String(options.type);
        const mode = modeOf(options);
        switch (type) {
          case 'tracks': {
            const { items, total } = await client.libraryTracks(page);
            printSavedTracks(items, mode, total, page.offset ?? 0);
            break;
          }
          case 'albums': {
            const { items, total } = await client.libraryAlbums(page);
            printAlbumList(items.map((s) => s.item), 'Saved albums', mode, total, page.offset ?? 0);
            break;
          }
          case 'shows': {
            const { items, total } = await client.libraryShows(page);
            printShowList(items.map((s) => s.item), 'Saved shows', mode, total, page.offset ?? 0);
            break;
          }
          case 'episodes': {
            const { items, total } = await client.libraryEpisodes(page);
            printEpisodeList(items.map((s) => s.item), 'Saved episodes', mode, total, page.offset ?? 0);
            break;
          }
          case 'audiobooks': {
            const { items, total } = await client.libraryAudiobooks(page);
            printAudiobookList(items.map((s) => s.item), 'Saved audiobooks', mode, total, page.offset ?? 0);
            break;
          }
          case 'artists': {
            const { items } = await client.libraryArtists(page);
            printArtistList(items, 'Followed artists', mode);
            break;
          }
          case 'playlists': {
            const { items, total } = await client.listPlaylists(page);
            printPlaylistList(items, 'Playlists', mode, total, page.offset ?? 0);
            break;
          }
          default:
            throw new CliError('INVALID_PARAMS', `Unknown library type: ${type}`);
        }
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = library.command('search')
      .description('Search your library (fetches all matching types each run; may use many requests)')
      .argument('<text>', 'Case- and accent-insensitive text')
      .option('--type <types>', 'Comma-separated: tracks,albums,artists,playlists,shows', 'tracks,albums,artists,playlists')
      .option('--in-playlists', 'Also search items inside owned/collaborative playlists');
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (text: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const needle = foldName(text);
        const types = String(options.type).split(',').map((t: string) => t.trim()).filter(Boolean);
        const mode = modeOf(options);
        const hits: Array<{ kind: string; uri: string; label: string; where?: string }> = [];

        if (types.includes('tracks')) {
          console.error('Fetching saved tracks…');
          const { items } = await client.libraryTracks({ all: true });
          for (const s of items) {
            const t = s.item;
            const blob = foldName(`${t.name} ${t.artists.map((a) => a.name).join(' ')} ${t.album?.name || ''}`);
            if (blob.includes(needle)) hits.push({ kind: 'track', uri: t.uri, label: `${t.name} — ${t.artists.map((a) => a.name).join(', ')}` });
          }
        }
        if (types.includes('albums')) {
          console.error('Fetching saved albums…');
          const { items } = await client.libraryAlbums({ all: true });
          for (const s of items) {
            const a = s.item;
            const blob = foldName(`${a.name} ${a.artists.map((x) => x.name).join(' ')}`);
            if (blob.includes(needle)) hits.push({ kind: 'album', uri: a.uri, label: `${a.name} — ${a.artists.map((x) => x.name).join(', ')}` });
          }
        }
        if (types.includes('artists')) {
          console.error('Fetching followed artists…');
          const { items } = await client.libraryArtists({ all: true });
          for (const a of items) {
            if (foldName(a.name).includes(needle)) hits.push({ kind: 'artist', uri: a.uri, label: a.name });
          }
        }
        if (types.includes('playlists') || options.inPlaylists) {
          console.error('Fetching playlists…');
          const playlists = await client.allPlaylists();
          if (types.includes('playlists')) {
            for (const p of playlists) {
              if (foldName(p.name).includes(needle) || foldName(p.description || '').includes(needle)) {
                hits.push({ kind: 'playlist', uri: p.uri, label: p.name });
              }
            }
          }
          if (options.inPlaylists) {
            const me = await client.me();
            const mine = playlists.filter((p) => p.ownerId === me.id || p.collaborative);
            for (const p of mine) {
              console.error(`Searching playlist ${p.name}…`);
              try {
                const { items } = await client.playlistItems(p.id, { all: true });
                for (const it of items) {
                  const t = it.track;
                  if (!t) continue;
                  const blob = foldName(`${t.name} ${t.artists.map((a) => a.name).join(' ')} ${t.album?.name || ''}`);
                  if (blob.includes(needle)) {
                    hits.push({
                      kind: 'track',
                      uri: t.uri,
                      label: `${t.name} — ${t.artists.map((a) => a.name).join(', ')}`,
                      where: p.name,
                    });
                  }
                }
              } catch {
                // skip playlists we can't read
              }
            }
          }
        }
        if (types.includes('shows')) {
          console.error('Fetching saved shows…');
          const { items } = await client.libraryShows({ all: true });
          for (const s of items) {
            if (foldName(s.item.name).includes(needle)) {
              hits.push({ kind: 'show', uri: s.item.uri, label: s.item.name });
            }
          }
        }

        if (mode.json) {
          const { writeJson } = await import('../../utils/output');
          writeJson({ query: text, hits }, 2);
          return;
        }
        if (mode.urisOnly) {
          for (const h of hits) console.log(h.uri);
          return;
        }
        if (hits.length === 0) {
          console.log('No matches');
          return;
        }
        for (const h of hits) {
          const where = h.where ? ` (in ${h.where})` : '';
          console.log(`${h.kind}: ${h.label}${where}  ${h.uri}`);
        }
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = library.command('save').description('Save/follow items (batches of 40)')
      .argument('<items...>', 'URIs/URLs, or - to read from stdin');
    addProfileOption(cmd);
    cmd.action(async (items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'save library items');
        const uris = await resolveItemArgs(items);
        for (const uri of uris) {
          if (uri.startsWith('spotify:local:')) {
            throw new CliError('INVALID_PARAMS', `Local tracks cannot be saved: ${uri}`);
          }
        }
        await client.librarySave(uris);
        console.log(`Saved ${uris.length} item(s)`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = library.command('remove').description('Remove/unfollow items (batches of 40)')
      .argument('<items...>', 'URIs/URLs, or - to read from stdin');
    addProfileOption(cmd);
    cmd.action(async (items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'remove library items');
        const uris = await resolveItemArgs(items);
        await client.libraryRemove(uris);
        console.log(`Removed ${uris.length} item(s)`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = library.command('contains').description('Check whether items are saved/followed')
      .argument('<items...>', 'URIs/URLs, or - to read from stdin');
    addProfileOption(cmd);
    cmd.action(async (items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const uris = await resolveItemArgs(items);
        const flags = await client.libraryContains(uris);
        uris.forEach((uri, i) => console.log(`${flags[i] ? 'yes' : 'no'}  ${uri}`));
      } catch (error) {
        handleError(error);
      }
    });
  }
}

function registerHistoryCommands(spotify: Command): void {
  {
    const cmd = spotify.command('history').description('Recently played (API returns at most the last 50 plays)')
      .option('--limit <n>', 'Max items (≤50)', '50')
      .option('--after <time>', 'Only plays after this ISO or relative time (2h, 1d)')
      .option('--before <time>', 'Only plays before this ISO or relative time');
    addOutputOptions(cmd);
    addProfileOption(cmd);
    addExamples(
      cmd.action(async (options) => {
        try {
          const { client } = await getSpotifyClient(options.profile);
          const limit = Math.min(parsePositiveInt(options.limit, '--limit'), 50);
          const after = options.after ? parseRelativeOrIsoTime(options.after) : undefined;
          const before = options.before ? parseRelativeOrIsoTime(options.before) : undefined;
          const items = await client.recentlyPlayed({ limit, after, before });
          printHistory(items, modeOf(options));
        } catch (error) {
          handleError(error);
        }
      }),
      `Examples:

  agentio spotify history
  agentio spotify history --after 2h --limit 20

The Web API only returns the last 50 plays. For full history, use Spotify's privacy data export.
History import from that export is not implemented in this plugin yet.`,
    );
  }

  const top = spotify.command('top').description('Top tracks and artists');

  {
    const cmd = top.command('tracks').description('Top tracks for a time range')
      .option('--range <range>', 'short|medium|long (≈4 weeks / 6 months / 1 year)', 'medium');
    addPagingOptions(cmd);
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const range = mapRange(options.range);
        const page = pageOf(options);
        const { items, total } = await client.topTracks(range, page);
        printTrackList(items, `Top tracks (${options.range})`, modeOf(options), total, page.offset ?? 0);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = top.command('artists').description('Top artists for a time range')
      .option('--range <range>', 'short|medium|long', 'medium');
    addPagingOptions(cmd);
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const range = mapRange(options.range);
        const page = pageOf(options);
        const { items, total } = await client.topArtists(range, page);
        printArtistList(items, `Top artists (${options.range})`, modeOf(options), total, page.offset ?? 0);
      } catch (error) {
        handleError(error);
      }
    });
  }
}

function mapRange(value: string): 'short_term' | 'medium_term' | 'long_term' {
  switch (String(value).toLowerCase()) {
    case 'short':
    case 'short_term':
      return 'short_term';
    case 'long':
    case 'long_term':
      return 'long_term';
    case 'medium':
    case 'medium_term':
      return 'medium_term';
    default:
      throw new CliError('INVALID_PARAMS', `Unknown range: ${value}`, 'Use short, medium, or long');
  }
}

function registerPlayerCommands(spotify: Command): void {
  const player = spotify.command('player').description('Playback control (Premium + active device)');

  {
    const cmd = player.command('status').description('Current playback state');
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        const state = await client.playerState();
        printPlayerStatus(state, modeOf(options));
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = player.command('devices').description('List available devices');
    addOutputOptions(cmd);
    addProfileOption(cmd);
    cmd.action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        printDevices(await client.devices(), modeOf(options));
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = player.command('play').description('Resume or start playback')
      .argument('[items...]', 'Track/episode URIs to play as a queue')
      .option('--context <uri>', 'Album, playlist, artist, or show URI/URL to play')
      .option('--offset <n-or-uri>', '1-based index or URI offset within the context')
      .option('--position <m:ss|ms>', 'Start position')
      .option('--device <name-or-id>', 'Target device');
    addProfileOption(cmd);
    cmd.action(async (items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        const devices = await client.devices();
        const device = resolveDevice(options.device, devices);
        if (options.device && !device?.id) {
          throw new CliError('NO_ACTIVE_DEVICE', 'Resolved device has no ID');
        }
        if (!options.device && !device?.id && devices.length > 0 && !devices.some((d) => d.isActive)) {
          // Will likely 404; pre-empt with a clearer error.
        }
        const uris = items.length ? await resolveItemArgs(items, ['track', 'episode']) : undefined;
        let contextUri: string | undefined;
        if (options.context) {
          contextUri = parseSpotifyRef(options.context, ['album', 'playlist', 'artist', 'show']).uri;
        }
        let offset: { position?: number; uri?: string } | undefined;
        if (options.offset) {
          if (/^\d+$/.test(options.offset)) {
            offset = { position: parsePositiveInt(options.offset, '--offset') - 1 };
          } else {
            offset = { uri: parseSpotifyRef(options.offset).uri };
          }
        }
        let positionMs: number | undefined;
        if (options.position) {
          try {
            positionMs = parseDuration(options.position);
          } catch {
            throw new CliError('INVALID_PARAMS', `Invalid --position: ${options.position}`);
          }
        }
        await withPlayerError(client, () => client.play({
          deviceId: device?.id ?? undefined,
          uris,
          contextUri,
          offset,
          positionMs,
        }));
        console.error('OK');
      } catch (error) {
        handleError(error);
      }
    });
  }

  for (const [name, desc, method] of [
    ['pause', 'Pause playback', 'pause'],
    ['next', 'Skip to next', 'next'],
    ['previous', 'Skip to previous', 'previous'],
  ] as const) {
    const cmd = player.command(name).description(desc).option('--device <name-or-id>', 'Target device');
    addProfileOption(cmd);
    cmd.action(async (options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        const devices = await client.devices();
        const device = resolveDevice(options.device, devices);
        await withPlayerError(client, () => (client as any)[method](device?.id ?? undefined));
        console.error('OK');
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = player.command('seek').description('Seek to a position')
      .argument('<position>', 'm:ss or milliseconds')
      .option('--device <name-or-id>', 'Target device');
    addProfileOption(cmd);
    cmd.action(async (position: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        let ms: number;
        try {
          ms = parseDuration(position);
        } catch {
          throw new CliError('INVALID_PARAMS', `Invalid position: ${position}`);
        }
        const devices = await client.devices();
        const device = resolveDevice(options.device, devices);
        await withPlayerError(client, () => client.seek(ms, device?.id ?? undefined));
        console.error(`Seeked to ${formatDuration(ms)}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = player.command('volume').description('Set volume 0-100')
      .argument('<percent>', '0-100')
      .option('--device <name-or-id>', 'Target device');
    addProfileOption(cmd);
    cmd.action(async (percent: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        const n = parseNonNegInt(percent, 'volume');
        if (n > 100) throw new CliError('INVALID_PARAMS', 'Volume must be 0-100');
        const devices = await client.devices();
        const device = resolveDevice(options.device, devices);
        await withPlayerError(client, () => client.volume(n, device?.id ?? undefined));
        console.error(`Volume ${n}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = player.command('shuffle').description('Set shuffle on/off')
      .argument('<state>', 'on or off')
      .option('--device <name-or-id>', 'Target device');
    addProfileOption(cmd);
    cmd.action(async (state: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        const on = state === 'on' ? true : state === 'off' ? false : null;
        if (on === null) throw new CliError('INVALID_PARAMS', 'shuffle state must be on or off');
        const devices = await client.devices();
        const device = resolveDevice(options.device, devices);
        await withPlayerError(client, () => client.shuffle(on, device?.id ?? undefined));
        console.error(`Shuffle ${state}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = player.command('repeat').description('Set repeat mode')
      .argument('<state>', 'off, track, or context')
      .option('--device <name-or-id>', 'Target device');
    addProfileOption(cmd);
    cmd.action(async (state: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        if (!['off', 'track', 'context'].includes(state)) {
          throw new CliError('INVALID_PARAMS', 'repeat state must be off, track, or context');
        }
        const devices = await client.devices();
        const device = resolveDevice(options.device, devices);
        await withPlayerError(client, () => client.repeat(state as 'off' | 'track' | 'context', device?.id ?? undefined));
        console.error(`Repeat ${state}`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const queue = player.command('queue').description('Show the playback queue');
    addOutputOptions(queue);
    addProfileOption(queue);
    addExamples(
      queue.action(async (options) => {
        try {
          const { client } = await getSpotifyClient(options.profile);
          printQueue(await client.queue(), modeOf(options));
        } catch (error) {
          handleError(error);
        }
      }),
      `Examples:

  agentio spotify player queue`,
    );

    const addCmd = queue.command('add').description('Add items to the queue (one API call each)')
      .argument('<items...>', 'URIs/URLs, or - to read from stdin')
      .option('--device <name-or-id>', 'Target device');
    addProfileOption(addCmd);
    addCmd.action(async (items: string[], options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        const uris = await resolveItemArgs(items, ['track', 'episode']);
        const devices = await client.devices();
        const device = resolveDevice(options.device, devices);
        for (const uri of uris) {
          await withPlayerError(client, () => client.queueAdd(uri, device?.id ?? undefined));
        }
        console.error(`Queued ${uris.length} item(s)`);
      } catch (error) {
        handleError(error);
      }
    });
  }

  {
    const cmd = player.command('transfer').description('Transfer playback to a device')
      .argument('<device>', 'Device name or ID')
      .option('--play', 'Start playing on the target device');
    addProfileOption(cmd);
    cmd.action(async (deviceArg: string, options) => {
      try {
        const { client } = await getSpotifyClient(options.profile);
        await enforceWritable(client, 'control playback');
        const devices = await client.devices();
        const device = resolveDevice(deviceArg, devices);
        if (!device?.id) throw new CliError('INVALID_PARAMS', 'Device has no ID');
        await withPlayerError(client, () => client.transfer(device.id!, !!options.play));
        console.error(`Transferred to ${device.name}`);
      } catch (error) {
        handleError(error);
      }
    });
  }
}

function registerProfileCommands(spotify: Command): void {
  const profile = createProfileCommands<SpotifyCredentials>(spotify, {
    service: 'spotify',
    displayName: 'Spotify',
    getExtraInfo: (credentials) => (credentials?.displayName || credentials?.userId
      ? ` - ${credentials.displayName || credentials.userId}`
      : ''),
  });

  addSetupOptions(
    profile
      .command('add')
      .description('Add a new Spotify profile (PKCE; bring your own app)')
      .option('--profile <name>', 'Profile name (defaults to Spotify user ID)')
      .option('--client-id <id>', 'Client ID from the Spotify Developer Dashboard')
      .option('--read-only', 'Request read scopes only; block writes and playback control')
      .option('--no-browser', 'Print the authorisation URL and paste the redirect URL back')
  )
    .action(async (options) => {
      try {
        await addProfileWithSetup('spotify', spotifyProfileAdd, options);
      } catch (error) {
        handleError(error);
      }
    });
}

export interface SpotifyProfileAddOptions {
  profile?: string;
  clientId?: string;
  readOnly?: boolean;
  browser?: boolean;
}

export async function spotifyProfileAdd(
  options: SpotifyProfileAddOptions,
  context: SetupContext,
): Promise<SetupResult<SpotifyCredentials>> {
  context.log('\nSpotify Setup\n');
  context.log(`\n${SPOTIFY_APP_SETUP_STEPS}\n`);

  const clientId = options.clientId !== undefined
    ? checkAnswer(SPOTIFY_CLIENT_ID_INPUT, options.clientId)
    : await context.ask(SPOTIFY_CLIENT_ID_INPUT);

  const readOnly = !!options.readOnly;
  // JSON mode never opens a browser, so --no-browser changes nothing there.
  const noBrowser = options.browser === false && !isJsonMode();

  context.log(readOnly
    ? '\nRequesting read scopes only (--read-only).\n'
    : '\nRequesting read and write scopes (including playback control).\n');

  const tokens = await authorizeSpotify({ clientId, readOnly, noBrowser }, context);

  const credentials: SpotifyCredentials = {
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
    authorizedAt: new Date().toISOString(),
    scopes: tokens.scopes.length > 0 ? tokens.scopes : [],
    userId: '',
    readOnly,
  };

  context.log('Validating access...');
  const client = new SpotifyClient(credentials);
  const me = await client.me();
  credentials.userId = me.id;
  credentials.displayName = me.displayName;

  return {
    credentials,
    suggestedProfileName: me.id,
    info: `Account: ${me.displayName} (${me.id})\nSign-in expires: ${new Date(Date.parse(credentials.authorizedAt) + 182 * 86400000).toISOString()}\nTest with: agentio spotify account`,
  };
}
