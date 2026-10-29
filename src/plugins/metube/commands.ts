import { Command } from 'commander';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createClientGetter } from '../../utils/client-factory';
import { addExamples } from '../../utils/command-tree';
import { CliError, handleError } from '../../utils/errors';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import { addProfileWithSetup } from '../profile-host';
import { checkAnswer } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import { MetubeClient, parseServerUrl, stateOf } from './client';
import { printDownloads, printStatus, progressLine, view, type DownloadView } from './output';
import type { MetubeAddRequest, MetubeCredentials, MetubeDownload, MetubeHistory } from './types';

const URL_INPUT: InputSpec = { label: 'MeTube server URL', kind: 'url', help: 'For example https://metube.example.com' };
const USERNAME_INPUT: InputSpec = { label: 'Username', kind: 'text', required: false, help: 'For a server behind HTTP basic auth; leave empty when it has none' };
const PASSWORD_INPUT: InputSpec = { label: 'Password', kind: 'secret' };

/** How often a wait asks the server where downloads stand. Tests shorten it. */
export const timing = { pollMs: 1000 };

const getMetubeClient = createClientGetter<MetubeCredentials, MetubeClient>({
  service: 'metube',
  createClient: (credentials) => new MetubeClient(credentials),
});

export interface MetubeProfileAddOptions extends ProfileAddOptions {
  url?: string;
  username?: string;
  password?: string;
}

export async function metubeProfileAdd(
  options: MetubeProfileAddOptions,
  context: SetupContext,
): Promise<SetupResult<MetubeCredentials>> {
  const url = parseServerUrl(options.url !== undefined ? checkAnswer(URL_INPUT, options.url) : await context.ask(URL_INPUT));
  const username = (options.username !== undefined ? checkAnswer(USERNAME_INPUT, options.username) : await context.ask(USERNAME_INPUT)).trim();
  const credentials: MetubeCredentials = { url };
  if (username) {
    credentials.username = username;
    credentials.password = options.password !== undefined ? checkAnswer(PASSWORD_INPUT, options.password) : await context.ask(PASSWORD_INPUT);
  } else if (options.password !== undefined) {
    throw new CliError('INVALID_PARAMS', '--password needs --username');
  }
  const client = new MetubeClient(credentials);
  const v = await client.version();
  // /version is open on some setups; /history proves the credentials work.
  await client.history();
  return {
    credentials,
    suggestedProfileName: new URL(url).hostname.split('.')[0] || 'default',
    info: `Connected to MeTube ${v.version} (yt-dlp ${v['yt-dlp']}) at ${client.host}`,
  };
}

// ---------------------------------------------------------------------------
// Operations, written against a client so tests can run them on a fake server.

export interface GetOptions {
  audio?: boolean;
  quality?: string;
  format?: string;
  folder?: string;
  output?: string;
  keep?: boolean;
  wait?: boolean;
}

export function addRequest(url: string, options: GetOptions): MetubeAddRequest {
  const request: MetubeAddRequest = {
    url,
    download_type: options.audio ? 'audio' : 'video',
    format: options.format ?? (options.audio ? 'mp3' : 'any'),
    quality: options.quality ?? 'best',
    auto_start: true,
  };
  if (options.folder !== undefined) {
    if (!options.folder.trim()) throw new CliError('INVALID_PARAMS', '--folder cannot be empty');
    request.folder = options.folder.trim();
  }
  return request;
}

/** Every download, each with whether it sits in the finished list. */
function entries(history: MetubeHistory): { d: MetubeDownload; inDone: boolean }[] {
  return [
    ...history.queue.map((d) => ({ d, inDone: false })),
    ...history.pending.map((d) => ({ d, inDone: false })),
    ...history.done.map((d) => ({ d, inDone: true })),
  ];
}

const stamp = (d: MetubeDownload) => `${d.url}\n${d.timestamp}`;

/**
 * Queues each link and returns the keys of the downloads it created. MeTube's /add answers only "ok", so the new
 * downloads are the ones whose key and queue time were not on the server before: a link downloaded before comes
 * back under its old key with a new time.
 */
export async function queueLinks(client: MetubeClient, urls: string[], options: GetOptions): Promise<string[]> {
  const requests = urls.map((url) => addRequest(url, options));
  const keys: string[] = [];
  for (const request of requests) {
    const before = new Set(entries(await client.history()).map(({ d }) => stamp(d)));
    await client.add(request);
    const created = entries(await client.history()).filter(({ d }) => !before.has(stamp(d))).map(({ d }) => d.url);
    if (created.length === 0) {
      throw new CliError('API_ERROR', `MeTube accepted ${request.url} but queued nothing`, 'It may already be downloading: agentio metube list --queue');
    }
    keys.push(...created.filter((k) => !keys.includes(k)));
  }
  return keys;
}

/** Waits until every key is in the finished list, writing progress to stderr. */
export async function waitFor(client: MetubeClient, keys: string[], report: (line: string) => void): Promise<{ d: MetubeDownload; inDone: boolean }[]> {
  const last = new Map<string, string>();
  for (;;) {
    const all = entries(await client.history());
    const ours = keys.map((k) => {
      const found = all.find(({ d }) => d.url === k);
      if (!found) throw new CliError('NOT_FOUND', `The download ${k} is no longer on the server`, 'Someone may have deleted it');
      return found;
    });
    for (const { d, inDone } of ours) {
      const text = inDone ? `${d.title}: ${stateOf(d, true)}` : progressLine(d);
      // Whole tens of a percent only, so a log is not flooded.
      const key = text.replace(/ (\d+)%.*/, (_, p) => ` ${Math.floor(Number(p) / 10) * 10}%`);
      if (last.get(d.url) !== key) { last.set(d.url, key); report(text); }
    }
    if (ours.every(({ inDone }) => inDone)) return ours;
    await Bun.sleep(timing.pollMs);
  }
}

/** Downloads each finished file to `dir` and, without `keep`, removes it from the server once it is saved. */
export async function fetchDownloads(client: MetubeClient, done: MetubeDownload[], dir: string, keep: boolean): Promise<DownloadView[]> {
  const views: DownloadView[] = [];
  for (const d of done) {
    const path = await client.fetchFile(d, dir);
    if (!keep) await client.delete([d.url], 'done');
    views.push(view(d, true, path));
  }
  return views;
}

/** The download an <id> names: MeTube's key (the page URL) or the site's video id. */
export function resolveId(history: MetubeHistory, id: string): { d: MetubeDownload; inDone: boolean } {
  const all = entries(history);
  const byKey = all.find(({ d }) => d.url === id);
  if (byKey) return byKey;
  const byId = all.filter(({ d }) => d.id === id);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) throw new CliError('INVALID_PARAMS', `Several downloads have the id ${id}`, 'Use its key instead (agentio metube list)');
  throw new CliError('NOT_FOUND', `No download ${id} on the server`, 'agentio metube list');
}

export function outputDir(output?: string): string {
  return output ? resolve(output) : join(homedir(), 'Downloads');
}

function failedOf(views: DownloadView[]): DownloadView[] {
  return views.filter((v) => v.state === 'failed');
}

function exitOnFailures(failed: DownloadView[]): void {
  if (failed.length > 0) {
    throw new CliError('API_ERROR', `${failed.length} download${failed.length > 1 ? 's' : ''} failed: ${failed.map((v) => `${v.title}: ${v.error ?? 'unknown error'}`).join('; ')}`);
  }
}

const stderr = (line: string) => process.stderr.write(`${line}\n`);
const PROFILE_OPTION = ['--profile <name>', 'Profile name (optional if only one profile exists)'] as const;

export function registerMetubeCommands(program: Command): void {
  const metube = program.command('metube').description('Download videos and audio from YouTube, X, Instagram and the other yt-dlp sites through your MeTube server');

  addExamples(
    addJsonOption(
      metube
        .command('get')
        .description('Download links on the server, then save the files here (~/Downloads by default) and remove them from the server')
        .argument('<url...>', 'Links to videos or playlists')
        .option('--audio', 'Audio only (MP3 unless --format says otherwise)')
        .option('--quality <q>', 'Video: best, 2160, 1440, 1080, 720, 480, 360, 240 or worst; audio: best, or a bitrate such as 320, 192, 128 (default: best)')
        .option('--format <f>', 'Video: any, mp4 or ios (default: any); audio: mp3, m4a, opus, wav, flac or auto (default: mp3)')
        .option('--folder <sub>', 'Subfolder on the server to download into')
        .option('-o, --output <dir>', 'Folder to save the files in (default: ~/Downloads)')
        .option('--keep', 'Keep the files on the server too')
        .option('--no-wait', 'Only queue the downloads and print their ids; save them later with fetch')
        .option(...PROFILE_OPTION),
    ).action(async (urls: string[], options: GetOptions & { profile?: string; json?: boolean }) => {
      try {
        const { client, profile } = await getMetubeClient(options.profile);
        await enforceWriteAccess('metube', profile, 'queue downloads');
        const keys = await queueLinks(client, urls, options);
        if (options.wait === false) {
          const history = await client.history();
          printDownloads(keys.map((k) => { const { d, inDone } = resolveId(history, k); return view(d, inDone); }), options.json);
          return;
        }
        const results = await waitFor(client, keys, stderr);
        const done = results.filter(({ d }) => stateOf(d, true) === 'finished').map(({ d }) => d);
        const saved = await fetchDownloads(client, done, outputDir(options.output), options.keep === true);
        const failed = results.filter(({ d }) => stateOf(d, true) === 'failed').map(({ d }) => view(d, true));
        printDownloads([...saved, ...failed], options.json);
        exitOnFailures(failed);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio metube get "https://www.youtube.com/watch?v=jNQXAC9IVRw"

  # MP3, into a folder of your choice
  agentio metube get --audio -o ~/Music "https://youtu.be/jNQXAC9IVRw"

  # 720p MP4, and keep a copy on the server
  agentio metube get --quality 720 --format mp4 --keep "https://x.com/user/status/123"

  # a long playlist: queue it now, save it later
  agentio metube get --no-wait "https://www.youtube.com/playlist?list=..."
  agentio metube fetch <id>`,
  );

  addExamples(
  addJsonOption(
    metube
      .command('list')
      .description('List downloads on the server: queued, finished and failed')
      .option('--queue', 'Only downloads still queued or downloading')
      .option('--done', 'Only finished downloads')
      .option('--failed', 'Only failed downloads')
      .option(...PROFILE_OPTION),
  ).action(async (options: { queue?: boolean; done?: boolean; failed?: boolean; profile?: string; json?: boolean }) => {
    try {
      const { client } = await getMetubeClient(options.profile);
      const wanted = new Set<string>();
      if (options.queue) wanted.add('queued');
      if (options.done) wanted.add('finished');
      if (options.failed) wanted.add('failed');
      const views = entries(await client.history()).map(({ d, inDone }) => view(d, inDone)).filter((v) => wanted.size === 0 || wanted.has(v.state));
      printDownloads(views, options.json);
    } catch (error) {
      handleError(error);
    }
  }),
    `Examples:

  agentio metube list

  agentio metube list --failed --json`,
  );

  addExamples(
  addJsonOption(
    metube
      .command('status')
      .description('Show one download: where it stands, its progress and its file')
      .argument('<id>', 'The video id or the key shown by list')
      .option('--follow', 'Keep watching until it is finished or failed, with progress on stderr')
      .option(...PROFILE_OPTION),
  ).action(async (id: string, options: { follow?: boolean; profile?: string; json?: boolean }) => {
    try {
      const { client } = await getMetubeClient(options.profile);
      let { d, inDone } = resolveId(await client.history(), id);
      if (options.follow && !inDone) [{ d, inDone }] = await waitFor(client, [d.url], stderr);
      const v = view(d, inDone);
      printStatus(v, options.json);
      if (options.follow) exitOnFailures(failedOf([v]));
    } catch (error) {
      handleError(error);
    }
  }),
    `Examples:

  agentio metube status jNQXAC9IVRw

  # wait until it is done
  agentio metube status jNQXAC9IVRw --follow`,
  );

  addExamples(
  addJsonOption(
    metube
      .command('fetch')
      .description('Save finished downloads here and remove them from the server')
      .argument('<id...>', 'Video ids or keys shown by list')
      .option('-o, --output <dir>', 'Folder to save the files in (default: ~/Downloads)')
      .option('--keep', 'Keep the files on the server too')
      .option(...PROFILE_OPTION),
  ).action(async (ids: string[], options: { output?: string; keep?: boolean; profile?: string; json?: boolean }) => {
    try {
      const { client, profile } = await getMetubeClient(options.profile);
      if (!options.keep) await enforceWriteAccess('metube', profile, 'remove downloads from the server');
      const history = await client.history();
      const chosen = ids.map((id) => resolveId(history, id));
      for (const { d, inDone } of chosen) {
        if (stateOf(d, inDone) !== 'finished') throw new CliError('INVALID_PARAMS', `"${d.title}" is ${stateOf(d, inDone)}, not finished`, `agentio metube status ${d.id}`);
      }
      printDownloads(await fetchDownloads(client, chosen.map(({ d }) => d), outputDir(options.output), options.keep === true), options.json);
    } catch (error) {
      handleError(error);
    }
  }),
    `Examples:

  agentio metube fetch jNQXAC9IVRw -o ~/Videos

  agentio metube fetch jNQXAC9IVRw --keep`,
  );

  addExamples(
  addJsonOption(
    metube
      .command('delete')
      .description('Remove downloads from the server: cancels queued ones, deletes finished ones with their files')
      .argument('<id...>', 'Video ids or keys shown by list')
      .option(...PROFILE_OPTION),
  ).action(async (ids: string[], options: { profile?: string; json?: boolean }) => {
    try {
      const { client, profile } = await getMetubeClient(options.profile);
      await enforceWriteAccess('metube', profile, 'delete downloads');
      const history = await client.history();
      const chosen = ids.map((id) => resolveId(history, id));
      const done = chosen.filter(({ inDone }) => inDone).map(({ d }) => d.url);
      const queued = chosen.filter(({ inDone }) => !inDone).map(({ d }) => d.url);
      if (done.length) await client.delete(done, 'done');
      if (queued.length) await client.delete(queued, 'queue');
      printRemoved(chosen.map(({ d, inDone }) => view(d, inDone)), options.json);
    } catch (error) {
      handleError(error);
    }
  }),
    `Examples:

  agentio metube delete jNQXAC9IVRw`,
  );

  addExamples(
  addJsonOption(
    metube
      .command('clear')
      .description('Remove every finished or every failed download from the server (finished ones with their files)')
      .option('--done', 'Remove the finished downloads')
      .option('--failed', 'Remove the failed downloads')
      .option(...PROFILE_OPTION),
  ).action(async (options: { done?: boolean; failed?: boolean; profile?: string; json?: boolean }) => {
    try {
      if (!options.done && !options.failed) throw new CliError('INVALID_PARAMS', 'Say what to clear: --done, --failed or both');
      const { client, profile } = await getMetubeClient(options.profile);
      await enforceWriteAccess('metube', profile, 'clear downloads');
      const views = (await client.history()).done.map((d) => view(d, true))
        .filter((v) => (options.done && v.state === 'finished') || (options.failed && v.state === 'failed'));
      if (views.length) await client.delete(views.map((v) => v.key), 'done');
      printRemoved(views, options.json);
    } catch (error) {
      handleError(error);
    }
  }),
    `Examples:

  agentio metube clear --failed

  agentio metube clear --done --failed`,
  );

  const profile = createProfileCommands<MetubeCredentials>(metube, {
    service: 'metube',
    displayName: 'MeTube',
  });

  addExamples(
    profile
      .command('add')
      .description('Add a MeTube server')
      .option('--url <url>', 'Server URL (asked for when absent)')
      .option('--username <user>', 'HTTP basic auth user (asked for when absent; empty for none)')
      .option('--password <password>', 'HTTP basic auth password (asked for when absent, which keeps it out of shell history)')
      .option('--profile <name>', 'Profile name (default: the first part of the host name)')
      .option('--read-only', 'Create as read-only profile (blocks write operations)')
      .action(async (options: MetubeProfileAddOptions) => {
        try {
          await addProfileWithSetup('metube', (o, context) => metubeProfileAdd(o as MetubeProfileAddOptions, context), options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # asks for the password
  agentio metube profile add --url https://metube.example.com --username me`,
  );
}

function printRemoved(views: DownloadView[], json?: boolean): void {
  if (json) { printDownloads(views, true); return; }
  if (views.length === 0) { console.log('Nothing to remove'); return; }
  for (const v of views) console.log(`Removed: ${v.title} (${v.id})`);
}
