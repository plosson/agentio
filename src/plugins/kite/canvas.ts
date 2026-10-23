/**
 * Kite canvases over the HTTP API: create, read, outline, and change one in
 * small operations. Every write names the version it was based on; Kite
 * refuses it with 409 when someone changed the canvas since, and the error
 * here says which version to read and resend against.
 */

import { CliError } from '../../utils/errors';
import { KiteClient, isMissingRoute, parseVersion, toDocument, type RawResponse } from './client';
import type { KiteDocument, KiteRawDocument } from './types';

const SINCE = '1.4.0';

export type CanvasSide = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left'];

export interface CanvasNode {
  id: string;
  type: 'text' | 'file' | 'link' | 'group';
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  [key: string]: unknown;
}

export interface Canvas {
  id: string;
  version: number;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasOutlineNode {
  id: string;
  type: string;
  summary: string;
  x: number;
  y: number;
  width: number;
  height: number;
  kite?: { kind: string; ref?: string; view?: string };
  children?: CanvasOutlineNode[];
}

export interface CanvasOutline {
  id: string;
  version: number;
  counts: { nodes: number; edges: number; groups: number };
  bounds: { x: number; y: number; width: number; height: number } | null;
  tree: CanvasOutlineNode[];
  freeSlot: { x: number; y: number };
}

/** One operation, as Kite's POST …/canvas/ops takes it. Kite checks the fields. */
export type CanvasOp = { op: string; [key: string]: unknown };

export interface CanvasOpsResult {
  id: string;
  version: number;
  /** The ids Kite chose for what was added, keyed by the `ref` each add carried. */
  ids: Record<string, string>;
  touched: string[];
  dryRun: boolean;
}

export interface CanvasVersion extends Canvas {
  title: string;
  currentVersion: number;
  current: boolean;
  created: string;
}

const isObject = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null && !Array.isArray(d);

/** The empty canvas `create` makes when no file is given. */
export const EMPTY_CANVAS = '{"nodes":[],"edges":[]}';

/** Parse a canvas file's text, so a typo is caught before it is sent. */
export function parseCanvasText(text: string, where: string): { nodes: unknown[]; edges: unknown[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError('INVALID_PARAMS', `${where} is not JSON`, 'A canvas is JSON Canvas 1.0: {"nodes": [...], "edges": [...]}');
  }
  if (!isObject(data) || (data.nodes !== undefined && !Array.isArray(data.nodes)) || (data.edges !== undefined && !Array.isArray(data.edges))) {
    throw new CliError('INVALID_PARAMS', `${where} is not a canvas`, 'A canvas is JSON Canvas 1.0: {"nodes": [...], "edges": [...]}');
  }
  return { nodes: (data.nodes as unknown[]) ?? [], edges: (data.edges as unknown[]) ?? [] };
}

/**
 * Operations from text: a JSON list of operations, or `{ "baseVersion": N,
 * "ops": [...] }`. The version in the text is used when no other is given.
 */
export function parseOpsText(text: string, where: string): { ops: CanvasOp[]; baseVersion?: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CliError('INVALID_PARAMS', `${where} is not JSON`, 'Give a list of operations, like [{"op":"move","id":"n1","x":0,"y":0}]');
  }
  let ops: unknown = data;
  let baseVersion: number | undefined;
  if (isObject(data)) {
    ops = data.ops;
    if (data.baseVersion !== undefined) baseVersion = parseVersion(data.baseVersion as number);
  }
  if (!Array.isArray(ops) || ops.length === 0 || !ops.every((o) => isObject(o) && typeof o.op === 'string')) {
    throw new CliError('INVALID_PARAMS', `${where} has no operations`, 'Give a list of operations, each with an "op", like [{"op":"move","id":"n1","x":0,"y":0}]');
  }
  return { ops: ops as CanvasOp[], baseVersion };
}

/** A whole number, for a coordinate or a size. */
export function parseNumber(value: unknown, what: string, min = -Infinity): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (String(value ?? '').trim() === '' || !Number.isFinite(n) || n < min) {
    throw new CliError('INVALID_PARAMS', `Not a number for ${what}: ${String(value)}`, min > -Infinity ? `Give a number of ${min} or more.` : 'Give a number, like 120 or -40.');
  }
  return n;
}

export function parseSide(value: string, what: string): CanvasSide {
  if (!SIDES.includes(value as CanvasSide)) {
    throw new CliError('INVALID_PARAMS', `Not a side for ${what}: ${value}`, `Use one of ${SIDES.join(', ')}.`);
  }
  return value as CanvasSide;
}

export class KiteCanvas {
  constructor(private readonly client: KiteClient) {}

  private base(id: string): string {
    return `/api/artifacts/${encodeURIComponent(id)}`;
  }

  /** Make a canvas document; it goes to your inbox like any other. */
  async create(input: { content: string; title?: string; description: string; summary?: string }): Promise<KiteDocument> {
    const res = await this.client.raw('POST', '/api/artifacts', {
      body: { type: 'canvas', content: input.content, title: input.title, description: input.description, summary: input.summary },
    });
    if (res.status !== 200 && res.status !== 201) {
      // Kite before canvases answers `Artifacts can be "markdown" or "html". Got "canvas".`
      const said = String((res.data as { error?: { message?: unknown } } | null)?.error?.message ?? '');
      if (res.status === 400 && /can be "markdown" or "html"/i.test(said)) throw this.tooOld();
      throw this.client.errorFor(res);
    }
    return toDocument(res.data as KiteRawDocument);
  }

  /** The whole canvas and the version it is at. `strict` leaves out Kite's own keys. */
  async get(reference: string, options: { strict?: boolean } = {}): Promise<Canvas> {
    const id = await this.client.documentId(reference);
    const res = await this.read(`${this.base(id)}/canvas`, { format: options.strict ? 'jsoncanvas-strict' : undefined },
      (d) => Array.isArray(d.nodes));
    const data = res.data as Record<string, unknown>;
    const kite = isObject(data.kite) ? data.kite : {};
    // Strict JSON Canvas has no room for the version; Kite sends it as a header too.
    const version = typeof kite.version === 'number' ? kite.version : Number(res.headers.get('x-artifact-version'));
    const { kite: _k, ...rest } = data;
    return { id, version, nodes: [], edges: [], ...(rest as object) } as Canvas;
  }

  /** What is on the canvas, as a short tree, without the whole JSON. */
  async outline(reference: string, options: { frame?: string; depth?: number } = {}): Promise<CanvasOutline> {
    const id = await this.client.documentId(reference);
    const res = await this.read(`${this.base(id)}/canvas/outline`,
      { frame: options.frame, depth: options.depth === undefined ? undefined : String(options.depth) }, (d) => Array.isArray(d.tree));
    const { docId: _d, ...rest } = res.data as Record<string, unknown>;
    return { id, ...(rest as object) } as CanvasOutline;
  }

  /** The version the canvas is at now, read the cheapest way. */
  async currentVersion(reference: string): Promise<number> {
    return (await this.outline(reference, { depth: 1 })).version;
  }

  /**
   * Apply operations in one batch: all of them or none, as one new version.
   * Without `baseVersion` the current one is read first, which suits one
   * self-contained change; a batch planned from something you read should
   * pass the version you read.
   */
  async ops(reference: string, ops: CanvasOp[], options: { baseVersion?: number; dryRun?: boolean } = {}): Promise<CanvasOpsResult> {
    const id = await this.client.documentId(reference);
    const baseVersion = options.baseVersion ?? (await this.currentVersion(id));
    const res = await this.client.raw('POST', `${this.base(id)}/canvas/ops`, {
      body: { baseVersion, ops, dryRun: options.dryRun ? true : undefined },
    });
    if (res.status === 200 || res.status === 201) {
      const d = res.data as Record<string, unknown>;
      return {
        id,
        version: d.version as number,
        ids: (d.ids as Record<string, string>) ?? {},
        touched: (d.touched as string[]) ?? [],
        dryRun: Boolean(options.dryRun),
      };
    }
    if (res.status === 409) throw this.conflict(id, baseVersion, res.data);
    if (isMissingRoute(res)) throw this.tooOld();
    throw this.client.errorFor(res);
  }

  /** One version of a canvas as it was. Not counted as a read. */
  async version(reference: string, version: string | number): Promise<CanvasVersion> {
    const old = await this.client.getVersion(reference, version);
    if (old.type !== 'canvas') {
      throw new CliError('INVALID_PARAMS', `Version ${old.version} of ${old.id} is ${old.type}, not a canvas`, `Read it with: agentio kite versions get ${old.id} ${old.version}`);
    }
    const parsed = parseCanvasText(old.content, `Version ${old.version}`);
    return {
      id: old.id, version: old.version, title: old.title, currentVersion: old.currentVersion, current: old.current, created: old.updated,
      nodes: parsed.nodes as CanvasNode[], edges: parsed.edges as CanvasEdge[],
    };
  }

  /** Make an old version the current one again, as a new version. Comments stay. */
  async restore(reference: string, version: string | number, baseVersion?: number): Promise<KiteDocument & { restoredFrom: number }> {
    const old = await this.client.getVersion(reference, version);
    if (old.type !== 'canvas') {
      throw new CliError('INVALID_PARAMS', `Version ${old.version} of ${old.id} is ${old.type}, not a canvas`, 'Only a canvas version can be restored here.');
    }
    const base = baseVersion ?? old.currentVersion;
    try {
      const doc = await this.client.replaceContent(old.id, 'canvas', old.content, base);
      return { ...doc, restoredFrom: old.version };
    } catch (e) {
      if (e instanceof CliError && /changed this document|version_conflict/i.test(`${e.message} ${e.suggestion ?? ''}`)) {
        throw this.conflict(old.id, base, undefined, `agentio kite canvas restore ${old.id} ${old.version}`);
      }
      throw e;
    }
  }

  private async read(path: string, query: Record<string, string | undefined>, isShape: (d: Record<string, unknown>) => boolean): Promise<RawResponse> {
    const res = await this.client.raw('GET', path, { query });
    if (res.status >= 200 && res.status < 300) {
      if (!isObject(res.data) || !isShape(res.data)) throw this.tooOld();
      return res;
    }
    if (isMissingRoute(res)) throw this.tooOld();
    throw this.client.errorFor(res);
  }

  private conflict(id: string, baseVersion: number, data: unknown, retry?: string): CliError {
    const details = (isObject(data) && isObject(data.error) && isObject(data.error.details) ? data.error.details : {}) as Record<string, unknown>;
    const now = typeof details.currentVersion === 'number' ? details.currentVersion : undefined;
    const had = typeof details.baseVersion === 'number' ? details.baseVersion : baseVersion;
    const message = now !== undefined
      ? `The canvas ${id} changed since version ${had}: it is at version ${now} now`
      : `The canvas ${id} changed since version ${had}`;
    const suggestion = retry
      ? `Nothing was changed. Run it again: ${retry}`
      : `Nothing was changed. Read it again (agentio kite canvas outline ${id}), check your operations still fit, then resend with --base-version ${now ?? '<the version you read>'}`;
    return new CliError('API_ERROR', message, suggestion);
  }

  private tooOld(): CliError {
    return new CliError('API_ERROR', `Kite at ${this.client.baseUrl} does not have canvases yet`, `Canvases need Kite ${SINCE} or later. Ask whoever runs it to update.`);
  }
}
