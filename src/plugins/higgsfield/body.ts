/**
 * The JSON body of a generation or estimate: `--json-body` with `--arg` merged over it, and local media
 * files swapped for the URLs Higgsfield gives them once uploaded.
 */
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { extname, resolve } from 'path';
import { CliError } from '../../utils/errors';

/** What `POST /files/generate-upload-url` accepts (docs.higgsfield.ai/docs/concepts/file-uploads), by extension. */
export const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

export type Body = Record<string, unknown>;

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** `true`, `false`, `null`, a number, or JSON starting with `[` or `{`; anything else is a string. */
export function argValue(text: string): unknown {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (NUMBER.test(text)) return Number(text);
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new CliError('INVALID_PARAMS', `Not valid JSON: ${text}`);
    }
  }
  return text;
}

/**
 * `key=value` pairs as an object. A key given more than once becomes an array, in order; `key[]=value`
 * makes an array even when given once.
 */
export function parseArgs(pairs: string[]): Body {
  const body: Body = {};
  const arrays = new Set<string>();
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new CliError('INVALID_PARAMS', `--arg needs key=value, got: ${pair}`);
    let key = pair.slice(0, eq).trim();
    const value = argValue(pair.slice(eq + 1));
    const forced = key.endsWith('[]');
    if (forced) key = key.slice(0, -2);
    if (!key) throw new CliError('INVALID_PARAMS', `--arg needs a key: ${pair}`);
    if (forced || key in body) {
      if (!arrays.has(key)) {
        body[key] = key in body ? [body[key]] : [];
        arrays.add(key);
      }
      (body[key] as unknown[]).push(value);
    } else {
      body[key] = value;
    }
  }
  return body;
}

/** `--json-body`: a file, or `-` for stdin. It must hold a JSON object. */
export function readJsonBody(source: string, stdin: () => string = () => readFileSync(0, 'utf8')): Body {
  const text = source === '-' ? stdin() : readFileSync(expandHome(source), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError('INVALID_PARAMS', `--json-body ${source} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('INVALID_PARAMS', `--json-body ${source} must be a JSON object`);
  return parsed as Body;
}

/** The request body: the JSON body, then each `--arg` key replacing the same key in it. */
export function buildBody(options: { arg?: string[]; jsonBody?: string }): Body {
  const base = options.jsonBody !== undefined ? readJsonBody(options.jsonBody) : {};
  return { ...base, ...parseArgs(options.arg ?? []) };
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path);
}

/** The content type of a local media file, or null when `value` is not one (a URL, a prompt, another extension). */
export function mediaTypeOf(value: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  return MEDIA_TYPES[extname(value).toLowerCase()] ?? null;
}

export type Uploader = (path: string, contentType: string) => Promise<string>;

/**
 * Every string in the body that names a local media file (by its extension: .jpg, .jpeg, .png, .webp,
 * .gif, .wav, .mp4) is uploaded and replaced by its public URL, at any depth. The same file is uploaded once.
 */
export async function uploadLocalFiles(body: Body, upload: Uploader): Promise<{ body: Body; uploaded: { path: string; url: string }[] }> {
  const done = new Map<string, string>();
  const swap = async (value: unknown): Promise<unknown> => {
    if (typeof value === 'string') {
      const contentType = mediaTypeOf(value);
      if (!contentType) return value;
      const path = expandHome(value);
      if (!existsSync(path) || !statSync(path).isFile()) throw new CliError('INVALID_PARAMS', `No such file: ${value}`, 'Give a local file or an https:// URL');
      if (!done.has(path)) done.set(path, await upload(path, contentType));
      return done.get(path);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await swap(item));
      return out;
    }
    if (value && typeof value === 'object') {
      const out: Body = {};
      for (const [k, v] of Object.entries(value)) out[k] = await swap(v);
      return out;
    }
    return value;
  };
  const swapped = (await swap(body)) as Body;
  return { body: swapped, uploaded: [...done].map(([path, url]) => ({ path, url })) };
}
