import { writeJson } from '../../utils/output';
import { stateOf } from './client';
import type { MetubeDownload, MetubeState } from './types';

/** One download as agentio reports it. `key` is what MeTube itself knows it by; `id` and `key` both work as an <id> argument. */
export interface DownloadView {
  id: string;
  key: string;
  title: string;
  state: MetubeState;
  status: string;
  type: string;
  format?: string;
  quality?: string;
  folder?: string;
  filename?: string;
  size?: number;
  percent?: number;
  error?: string;
  path?: string;
}

export function view(d: MetubeDownload, inDone: boolean, path?: string): DownloadView {
  const v: DownloadView = {
    id: d.id,
    key: d.url,
    title: d.title,
    state: stateOf(d, inDone),
    status: d.status,
    type: d.download_type,
  };
  if (d.format) v.format = d.format;
  if (d.quality) v.quality = d.quality;
  if (d.folder) v.folder = d.folder;
  if (d.filename) v.filename = d.filename;
  if (typeof d.size === 'number') v.size = d.size;
  if (typeof d.percent === 'number') v.percent = Math.round(d.percent * 10) / 10;
  const error = d.error ?? (stateOf(d, inDone) === 'failed' ? d.msg : undefined);
  if (error) v.error = error;
  if (path) v.path = path;
  return v;
}

export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

function line(v: DownloadView): string {
  const parts = [`[${v.state}]`, v.title, `(${v.id})`];
  if (v.state === 'queued') parts.push(`${v.status}${v.percent !== undefined ? ` ${v.percent}%` : ''}`);
  if (v.size !== undefined) parts.push(formatSize(v.size));
  return parts.join(' ');
}

export function printDownloads(views: DownloadView[], json?: boolean): void {
  if (json) { writeJson(views, 2); return; }
  if (views.length === 0) { console.log('No downloads'); return; }
  for (const v of views) {
    console.log(line(v));
    if (v.path) console.log(`  Saved: ${v.path}`);
    else if (v.filename && v.state === 'finished') console.log(`  File: ${v.filename}`);
    if (v.error) console.log(`  Error: ${v.error}`);
    if (v.key !== v.id) console.log(`  Key: ${v.key}`);
  }
}

export function printStatus(v: DownloadView, json?: boolean): void {
  if (json) { writeJson(v, 2); return; }
  console.log(v.title);
  console.log(`  ID: ${v.id}`);
  console.log(`  Key: ${v.key}`);
  console.log(`  State: ${v.state} (${v.status})`);
  console.log(`  Type: ${v.type}${v.format ? ` ${v.format}` : ''}${v.quality ? ` ${v.quality}` : ''}`);
  if (v.percent !== undefined && v.state === 'queued') console.log(`  Progress: ${v.percent}%`);
  if (v.filename) console.log(`  File: ${v.filename}${v.size !== undefined ? ` (${formatSize(v.size)})` : ''}`);
  if (v.folder) console.log(`  Folder: ${v.folder}`);
  if (v.error) console.log(`  Error: ${v.error}`);
}

/** One line on stderr per change, so a long wait shows it is alive without flooding a log. */
export function progressLine(d: MetubeDownload): string {
  const pct = typeof d.percent === 'number' ? ` ${Math.floor(d.percent)}%` : '';
  const speed = typeof d.speed === 'number' ? ` ${formatSize(d.speed)}/s` : '';
  const eta = typeof d.eta === 'number' ? ` eta ${Math.round(d.eta)}s` : '';
  return `${d.title}: ${d.status}${pct}${speed}${eta}`;
}
