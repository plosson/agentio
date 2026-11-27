import { access, lstat, readFile, stat, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { basename, dirname, extname, resolve } from 'path';
import { CliError } from '../../utils/errors';
import type { PicsiImage } from './types';

const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MAX_INPUT_BYTES = 30 * 1024 * 1024;

/** Read inputs before requesting a processing slot or spending credits. */
export async function readImage(path: string): Promise<PicsiImage> {
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) throw new CliError('INVALID_PARAMS', 'Picsi image swaps take JPG, PNG or WebP files', 'Use a local image file; GIF and video swaps are not supported by this command');
  let bytes: Buffer;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > MAX_INPUT_BYTES) throw new Error();
    bytes = await readFile(path);
  } catch {
    throw new CliError('INVALID_PARAMS', `Cannot read image: ${path}`, 'Use a non-empty image file of at most 30 MB');
  }
  return { blob: new Blob([new Uint8Array(bytes)], { type }), name: basename(path) };
}

/** Refuse existing files, symlinks and missing output folders before uploading anything. */
export async function checkDestination(path: string): Promise<string> {
  if (!path.trim()) throw new CliError('INVALID_PARAMS', '--output must name a file');
  const output = resolve(path);
  let exists = true;
  try { await lstat(output); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
    else throw new CliError('INVALID_PARAMS', `Cannot access output: ${output}`);
  }
  if (exists) throw new CliError('INVALID_PARAMS', `Output already exists: ${output}`, 'Choose a new file name');
  try { await access(dirname(output), constants.W_OK); }
  catch { throw new CliError('INVALID_PARAMS', `Output folder is missing or not writable: ${dirname(output)}`); }
  return output;
}

/** Returned URLs are downloaded without account credentials. Data-URL outputs stay local. */
export async function saveImage(output: string, path: string): Promise<void> {
  const destination = await checkDestination(path);
  let bytes: Uint8Array;
  const embedded = output.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (embedded) {
    bytes = Buffer.from(embedded[1], 'base64');
  } else {
    let url: URL;
    try { url = new URL(output); }
    catch { throw new CliError('API_ERROR', 'Picsi returned an invalid image address'); }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password) {
      throw new CliError('API_ERROR', 'Picsi returned an unsupported image address');
    }
    let response: Response;
    try { response = await fetch(url, { signal: AbortSignal.timeout(60_000) }); }
    catch { throw new CliError('NETWORK_ERROR', 'Could not download the swapped image', 'The swap completed; check Picsi before submitting it again'); }
    if (!response.ok) throw new CliError('API_ERROR', `Could not download the swapped image (HTTP ${response.status})`, 'The swap completed; check Picsi before submitting it again');
    if (!/^image\/(?:png|jpeg|jpg|webp)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new CliError('API_ERROR', 'Picsi returned a download that is not a supported image');
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (bytes.length === 0) throw new CliError('API_ERROR', 'Picsi returned an empty image');
  try { await writeFile(destination, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('INVALID_PARAMS', `Output already exists: ${destination}`, 'Choose a new file name');
    throw new CliError('API_ERROR', `Could not save the swapped image to ${destination}`, 'The swap completed; check Picsi before submitting it again');
  }
}
