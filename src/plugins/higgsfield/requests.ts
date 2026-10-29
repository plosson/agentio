/** Submitting, waiting for and saving generation requests, written against a client so tests can use a fake API. */
import { existsSync, statSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { readPluginCache, writePluginCache } from '../../config/plugin-cache';
import { CliError } from '../../utils/errors';
import { HiggsfieldApiError, type HiggsfieldClient } from './client';
import { TERMINAL_STATES, type RequestRecord, type RequestStatus, type SubmitResponse } from './types';

/** Waits, in milliseconds. Tests set them to zero. */
export const timing = {
  /** Polling starts at 2 s and grows by half up to 10 s, as docs.higgsfield.ai/docs/concepts/polling advises. */
  pollStartMs: 2000,
  pollMaxMs: 10_000,
  jitterMs: 500,
  /** Waits between submission attempts when the API gives no Retry-After. */
  submitBackoffMs: [2000, 5000, 10_000, 20_000, 30_000],
  /** Consecutive failed status checks before a wait gives up. */
  statusAttempts: 5,
};

export type Report = (line: string) => void;

function retryable(error: unknown): boolean {
  if (error instanceof HiggsfieldApiError) return error.retryable;
  return error instanceof CliError && error.code === 'NETWORK_ERROR';
}

/**
 * Submits once, and again with the same Idempotency-Key after a full queue (429, after Retry-After), a 5xx or a
 * network failure, so a retry never creates a second request.
 */
export async function submit(client: HiggsfieldClient, model: string, body: Record<string, unknown>, idempotencyKey: string, report: Report): Promise<SubmitResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.submit(model, body, idempotencyKey);
    } catch (error) {
      if (!retryable(error) || attempt >= timing.submitBackoffMs.length) throw error;
      const after = error instanceof HiggsfieldApiError && error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : timing.submitBackoffMs[attempt];
      report(`${(error as Error).message}; retrying in ${Math.ceil(after / 1000)}s`);
      await Bun.sleep(after);
    }
  }
}

export const isTerminal = (status: RequestStatus) => TERMINAL_STATES.includes(status.status);

/** Polls until the request is completed, failed, nsfw or canceled, reporting each change of status. */
export async function waitFor(client: HiggsfieldClient, requestId: string, report: Report): Promise<RequestStatus> {
  let delay = timing.pollStartMs;
  let failures = 0;
  let last = '';
  for (;;) {
    let status: RequestStatus | null = null;
    try {
      status = await client.status(requestId);
      failures = 0;
    } catch (error) {
      if (!retryable(error) || ++failures >= timing.statusAttempts) throw error;
      report(`${(error as Error).message}; checking again`);
    }
    if (status) {
      if (status.status !== last) { last = status.status; report(`${requestId}: ${status.status}`); }
      if (isTerminal(status)) return status;
    }
    await Bun.sleep(delay + Math.random() * timing.jitterMs);
    delay = Math.min(delay * 1.5, timing.pollMaxMs);
  }
}

/** Every output URL of a finished request: `images`, `video`, `audio`, `audios` and any other `{ url }` field. */
export function outputUrls(status: RequestStatus): string[] {
  const urls: string[] = [];
  const add = (v: unknown) => {
    const url = (v as { url?: unknown } | null)?.url;
    if (typeof url === 'string' && url && !urls.includes(url)) urls.push(url);
  };
  for (const [field, value] of Object.entries(status)) {
    if (field === 'status_url' || field === 'cancel_url') continue;
    if (Array.isArray(value)) value.forEach(add);
    else add(value);
  }
  return urls;
}

/**
 * Where each output goes. `output` is a folder when it exists as one or ends with a slash, else a file name;
 * several outputs into one file name become name-1.ext, name-2.ext… Files are named after the request in a folder.
 */
export function destinations(urls: string[], requestId: string, output?: string): string[] {
  const target = resolve(output ?? '.');
  const isDir = output === undefined || /[/\\]$/.test(output) || (existsSync(target) && statSync(target).isDirectory());
  return urls.map((url, i) => {
    const n = urls.length > 1 ? `-${i + 1}` : '';
    if (isDir) return join(target, `${requestId}${n}${extname(new URL(url).pathname)}`);
    if (!n) return target;
    const ext = extname(target);
    return join(dirname(target), `${basename(target, ext)}${n}${ext}`);
  });
}

export async function saveOutputs(client: HiggsfieldClient, status: RequestStatus, output?: string): Promise<string[]> {
  const urls = outputUrls(status);
  if (urls.length === 0) throw new CliError('API_ERROR', `Request ${status.request_id} is completed but has no output`);
  const paths = destinations(urls, status.request_id, output);
  for (const path of paths) if (existsSync(path)) throw new CliError('INVALID_PARAMS', `${path} already exists`, 'Choose another -o');
  for (let i = 0; i < urls.length; i++) await client.download(urls[i], paths[i]);
  return paths;
}

/** A finished request that did not complete, as an error. */
export function failureOf(status: RequestStatus): CliError | null {
  const why = status.error ? `: ${status.error}` : '';
  if (status.status === 'failed') return new CliError('API_ERROR', `Request ${status.request_id} failed${why}`, 'Failed requests are not charged');
  if (status.status === 'nsfw') return new CliError('API_ERROR', `Request ${status.request_id} was rejected by content moderation (nsfw)${why}`, 'Rejected requests are not charged');
  if (status.status === 'canceled') return new CliError('API_ERROR', `Request ${status.request_id} was canceled`);
  return null;
}

// ---------------------------------------------------------------------------
// The local list of requests: the API has no endpoint that lists them.

const CACHE_NAME = 'requests';
const MAX_RECORDS = 500;

export async function readRecords(profile: string): Promise<RequestRecord[]> {
  return (await readPluginCache<RequestRecord[]>('higgsfield', profile, CACHE_NAME)) ?? [];
}

/** Adds or updates one request, newest first. */
export async function saveRecord(profile: string, record: Partial<RequestRecord> & { requestId: string }): Promise<void> {
  const records = await readRecords(profile);
  const i = records.findIndex((r) => r.requestId === record.requestId);
  if (i >= 0) records[i] = { ...records[i], ...record };
  else if (record.model && record.createdAt && record.status) records.unshift(record as RequestRecord);
  else return;
  await writePluginCache('higgsfield', profile, CACHE_NAME, records.slice(0, MAX_RECORDS));
}

/** Records what a status check says, for a request in the local list. */
export async function noteStatus(profile: string, status: RequestStatus, outputs?: string[]): Promise<void> {
  const update: Partial<RequestRecord> & { requestId: string } = { requestId: status.request_id, status: status.status };
  if (status.error) update.error = status.error;
  if (outputs) update.outputs = outputs;
  await saveRecord(profile, update);
}
