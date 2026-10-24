/**
 * `agentio kite canvas …`: canvases over Kite's HTTP API. Reads print the
 * version they saw; every change is one batch of operations against a
 * version, and a 409 says which version to read and resend against.
 */

import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { addExamples } from '../../utils/command-tree';
import { CliError } from '../../utils/errors';
import { writeJson } from '../../utils/output';
import { parseVersion } from './client';
import {
  EMPTY_CANVAS,
  KiteCanvas,
  parseCanvasText,
  parseNumber,
  parseOpsText,
  parseSide,
  type Canvas,
  type CanvasOp,
  type CanvasOpsResult,
  type CanvasOutline,
  type CanvasOutlineNode,
  type CanvasVersion,
} from './canvas';
import {
  anyStyle,
  edgeEnds,
  edgeStyle,
  edgeStyleFlags,
  iconFlags,
  iconFromOptions,
  nodeStyle,
  nodeStyleFlags,
  splitUnset,
  themeFlags,
  themeFromOptions,
} from './canvas-style';
import { checkOutPath, getKiteClient, getWritableClient, leaf, run, summaryFrom } from './commands';
import { printDocument, printVersions } from './output';

const REF = ['<id-or-link>', 'A canvas id (art_…) or its link (https://…/a/<slug>)'] as const;
const BASE = ['--base-version <n>', 'The version you read the canvas at; Kite refuses the change if it moved on since. Leave out to use the current one'] as const;

function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data, 2);
  else text();
}

async function readText(path: string): Promise<string> {
  try {
    return path === '-' ? await new Response(Bun.stdin.stream()).text() : await readFile(path, 'utf8');
  } catch {
    throw new CliError('INVALID_PARAMS', `Cannot read ${path}`);
  }
}

function optionalVersion(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseVersion(value);
}

/** A batch's result: the new version, and the ids Kite chose. */
function printOps(result: CanvasOpsResult, count: number, json?: boolean): void {
  emit(json, result, () => {
    if (result.dryRun) {
      console.log(`Dry run: the ${count === 1 ? 'operation applies' : `${count} operations apply`} to ${result.id} at version ${result.version}. Nothing was changed.`);
    } else {
      console.log(`${result.id} is at version ${result.version} now.`);
    }
    for (const [ref, id] of Object.entries(result.ids)) console.log(`  ${ref} → ${id}`);
    if (result.touched.length) console.log(`  Touched: ${result.touched.join(', ')}`);
  });
}

function outlineLines(nodes: CanvasOutlineNode[], depth: number): void {
  for (const n of nodes) {
    const size = `${Math.round(n.width)}×${Math.round(n.height)} at ${Math.round(n.x)},${Math.round(n.y)}`;
    console.log(`${'  '.repeat(depth)}- ${n.id} [${n.type}] ${n.summary}  (${size})`);
    if (n.children) outlineLines(n.children, depth + 1);
  }
}

function printOutline(outline: CanvasOutline, json?: boolean): void {
  emit(json, outline, () => {
    const c = outline.counts;
    console.log(`${outline.id}, version ${outline.version}: ${c.nodes} nodes (${c.groups} groups), ${c.edges} edges`);
    outlineLines(outline.tree, 0);
    console.log(`Free spot for a new node: ${outline.freeSlot.x},${outline.freeSlot.y}`);
  });
}

/** One change, against the version given or the current one. */
async function change(reference: string, ops: CanvasOp[], options: { profile?: string; baseVersion?: string; dryRun?: boolean; json?: boolean }, what: string): Promise<void> {
  const client = await getWritableClient(options.profile, what);
  const result = await new KiteCanvas(client).ops(reference, ops, { baseVersion: optionalVersion(options.baseVersion), dryRun: options.dryRun });
  printOps(result, ops.length, options.json);
}

function changeOptions(command: Command): Command {
  return command.option(...BASE).option('--dry-run', 'Check the change against the canvas without making it');
}

export function registerCanvasCommands(kite: Command): void {
  const canvas = kite
    .command('canvas')
    .description('Canvases: boards of text, links, Kite documents and groups, joined by edges (Kite 1.4.0+, HTTP only)');

  addExamples(
    leaf(canvas, 'create', 'Make a canvas from a JSON Canvas file, or an empty one')
      .argument('[file]', 'A .canvas or .json file (JSON Canvas 1.0); leave out for an empty canvas')
      .option('--title <title>', 'Canvas title')
      .requiredOption('--description <text>', 'One line, at most 160 characters, on what the canvas is for')
      .option('--summary <text>', 'At most 10 lines and 1200 characters on what it shows')
      .option('--summary-file <file>', 'Read the summary from this file instead')
      .action(run(async (file: string | undefined, options) => {
        const content = file === undefined ? EMPTY_CANVAS : await readText(file);
        parseCanvasText(content, file ?? 'The canvas');
        const summary = await summaryFrom(options);
        const client = await getWritableClient(options.profile, 'create a canvas');
        printDocument(await new KiteCanvas(client).create({ content, title: options.title, description: options.description, summary }), options.json);
      })),
    `Examples:

  # an empty canvas, to fill with add and connect
  agentio kite canvas create --title "Launch plan" --description "What ships when" --summary "Nothing yet."

  # from a JSON Canvas file, such as one saved by Obsidian
  agentio kite canvas create plan.canvas --title "Plan" --description "The plan as a board" --summary-file summary.txt --json`,
  );

  addExamples(
    leaf(canvas, 'get', 'Read the whole canvas as JSON, with the version it is at')
      .argument(...REF)
      .option('--strict', 'Plain JSON Canvas 1.0, without Kite\'s own keys')
      .option('--out <file>', 'Write nodes and edges to this file instead of printing them')
      .action(run(async (reference: string, options) => {
        const out = options.out !== undefined ? await checkOutPath(options.out) : undefined;
        const { client } = await getKiteClient(options.profile);
        const doc: Canvas = await new KiteCanvas(client).get(reference, { strict: options.strict });
        if (out) {
          const { id: _i, version: _v, ...file } = doc;
          try { await writeFile(out, `${JSON.stringify(file, null, 2)}\n`); } catch { throw new CliError('INVALID_PARAMS', `Cannot write ${options.out}`); }
          emit(options.json, { id: doc.id, version: doc.version, file: out }, () => console.log(`${doc.id}, version ${doc.version}, written to ${out}`));
          return;
        }
        writeJson(doc, 2);
      })),
    `Examples:

  agentio kite canvas get art_abc123
  agentio kite canvas get art_abc123 --strict --out board.canvas

For a large canvas, start with outline: it is much shorter.`,
  );

  addExamples(
    leaf(canvas, 'outline', 'What is on a canvas, as a short tree of groups and nodes')
      .argument(...REF)
      .option('--frame <group-id>', 'Only what is inside this group')
      .option('--depth <n>', 'How many levels of groups to open (1 = top level only)')
      .action(run(async (reference: string, options) => {
        const depth = options.depth === undefined ? undefined : parseNumber(options.depth, '--depth', 1);
        const { client } = await getKiteClient(options.profile);
        printOutline(await new KiteCanvas(client).outline(reference, { frame: options.frame, depth }), options.json);
      })),
    `Examples:

  agentio kite canvas outline art_abc123
  agentio kite canvas outline art_abc123 --frame g1 --depth 1 --json

The first line has the version; pass it to a change as --base-version.`,
  );

  addExamples(
    changeOptions(
      leaf(canvas, 'ops', 'Apply a batch of operations: all or none, as one new version')
        .argument(...REF)
        .argument('[file]', 'A JSON file of operations, or - for stdin')
        .option('--ops <json>', 'The operations as JSON, instead of a file'),
    ).action(run(async (reference: string, file: string | undefined, options) => {
      if ((file === undefined) === (options.ops === undefined)) {
        throw new CliError('INVALID_PARAMS', 'Give the operations as a file or with --ops, not both or neither');
      }
      const parsed = parseOpsText(options.ops ?? (await readText(file!)), file ?? '--ops');
      const baseVersion = optionalVersion(options.baseVersion) ?? parsed.baseVersion;
      if (baseVersion === undefined) {
        throw new CliError('INVALID_PARAMS', 'A batch needs the version it was planned against',
          `Pass --base-version, the version outline or get showed (agentio kite canvas outline ${reference})`);
      }
      const client = await getWritableClient(options.profile, 'change a canvas');
      printOps(await new KiteCanvas(client).ops(reference, parsed.ops, { baseVersion, dryRun: options.dryRun }), parsed.ops.length, options.json);
    })),
    `Examples:

  # a question under n1, joined to it, in one version
  agentio kite canvas ops art_abc123 --base-version 7 --ops '[
    {"op":"add","tempId":"q","near":"n1","side":"bottom","node":{"type":"text","text":"Open question"}},
    {"op":"connect","from":"n1","to":"q","label":"asks"}]'

  # from a file; {"baseVersion": 7, "ops": [...]} carries its own version
  agentio kite canvas ops art_abc123 changes.json --dry-run

Operations: add, update, move, resize, delete, connect, disconnect. Later ones
can name an earlier add by its tempId. If the canvas changed since the version
you give, nothing is applied: read it again and resend with the new version.`,
  );

  addExamples(
    changeOptions(iconFlags(nodeStyleFlags(
      leaf(canvas, 'add', 'Add a text, link, Kite document or group; placed clear of the rest unless --at is given')
        .argument(...REF)
        .option('--text <text>', 'A text node (plain text)')
        .option('--link <url>', 'A link node, to this web address')
        .option('--doc <id-or-link>', 'A node showing one of your Kite documents')
        .option('--view <view>', 'For --doc: card (title and description) or preview (the document itself)', 'card')
        .option('--group <label>', 'A group, a labelled box')
        .option('--near <node-id>', 'Put it beside this node')
        .option('--side <side>', 'Which side of --near: top, right, bottom or left', 'right')
        .option('--in <group-id>', 'Put it inside this group')
        .option('--at <x,y>', 'Exactly here instead')
        .option('--width <n>', 'Width')
        .option('--height <n>', 'Height')
        .option('--color <color>', 'A JSON Canvas color: 1–6 or #rrggbb'),
    ))).action(run(async (reference: string, options) => {
      const kinds = ['text', 'link', 'doc', 'group'].filter((k) => options[k] !== undefined);
      if (kinds.length !== 1) throw new CliError('INVALID_PARAMS', 'Give one of --text, --link, --doc or --group');
      if (options.view !== 'card' && options.view !== 'preview') throw new CliError('INVALID_PARAMS', `Not a view: ${options.view}`, 'Use card or preview.');
      const node: Record<string, unknown> = {};
      if (options.text !== undefined) Object.assign(node, { type: 'text', text: options.text });
      if (options.link !== undefined) Object.assign(node, { type: 'link', url: options.link });
      if (options.group !== undefined) Object.assign(node, { type: 'group', label: options.group });
      if (options.at !== undefined) {
        const [x, y, extra] = String(options.at).split(',');
        if (extra !== undefined || y === undefined) throw new CliError('INVALID_PARAMS', `Not a position: ${options.at}`, 'Give x,y, like --at 120,-40');
        Object.assign(node, { x: parseNumber(x, '--at x'), y: parseNumber(y, '--at y') });
      }
      if (options.width !== undefined) node.width = parseNumber(options.width, '--width', 1);
      if (options.height !== undefined) node.height = parseNumber(options.height, '--height', 1);
      if (options.color !== undefined) node.color = options.color;
      const style = nodeStyle(options);
      const { icon, ops: before } = await iconFromOptions(options, readText);
      if (Object.keys(style).length || icon) node.kite = { ...(Object.keys(style).length ? { style } : {}), ...(icon ? { icon } : {}) };
      const op: CanvasOp = { op: 'add', tempId: 'new', node };
      if (options.in !== undefined) op.in = options.in;
      if (options.near !== undefined) Object.assign(op, { near: options.near, side: parseSide(options.side, '--side') });
      const client = await getWritableClient(options.profile, 'change a canvas');
      if (options.doc !== undefined) {
        const doc = await client.get(options.doc);
        const preview = options.view === 'preview';
        Object.assign(node, {
          type: 'link', url: doc.url, kite: { ...((node.kite as object | undefined) ?? {}), kind: 'kite', ref: doc.id, view: options.view },
          width: node.width ?? (preview ? 420 : 320), height: node.height ?? (preview ? 360 : 110),
        });
      }
      const ops = [...before, op];
      const result = await new KiteCanvas(client).ops(reference, ops, { baseVersion: optionalVersion(options.baseVersion), dryRun: options.dryRun });
      printOps(result, ops.length, options.json);
    })),
    `Examples:

  agentio kite canvas add art_abc123 --text "Open question: who signs off?" --near n1 --side bottom
  agentio kite canvas add art_abc123 --link https://jsoncanvas.org --in g1
  agentio kite canvas add art_abc123 --doc art_def456 --view preview --at 800,0
  agentio kite canvas add art_abc123 --group "Later" --json

  # styled, with an icon
  agentio kite canvas add art_abc123 --text "API server" --fill "#eef4ff" --border "#3b6fd8" --font grotesk --icon lucide:server
  agentio kite canvas add art_abc123 --text "Acme" --icon-svg logo.svg --icon-position top --icon-size 48

The new node's id is printed (new → n_…); use it to connect or move it. With
--icon-svg, Kite cleans the SVG and keeps it on the canvas (icon → a_…); other
nodes can show it with --icon asset:a_….`,
  );

  addExamples(
    changeOptions(edgeStyleFlags(iconFlags(nodeStyleFlags(
      leaf(canvas, 'update', 'Change a node\'s text, link, label, color, style or icon, or an edge\'s label, color, sides or style')
        .argument(...REF)
        .argument('<node-or-edge-id>', 'What to change')
        .option('--text <text>', 'New text, for a text node')
        .option('--link <url>', 'New address, for a link node')
        .option('--label <label>', 'New label, for a group or an edge')
        .option('--color <color>', 'A JSON Canvas color: 1–6 or #rrggbb')
        .option('--from-side <side>', 'For an edge: the side it leaves from')
        .option('--to-side <side>', 'For an edge: the side it arrives at')
        .option('--unset <field...>', 'Remove these fields, such as color or label; style or icon removes the whole style or icon, style.<key> one style key (style.fill)'),
    )), { colour: false, labels: false })).action(run(async (reference: string, id: string, options) => {
      const set: Record<string, unknown> = {};
      for (const key of ['text', 'label', 'color'] as const) if (options[key] !== undefined) set[key] = options[key];
      if (options.link !== undefined) set.url = options.link;
      if (options.fromSide !== undefined) set.fromSide = parseSide(options.fromSide, '--from-side');
      if (options.toSide !== undefined) set.toSide = parseSide(options.toSide, '--to-side');
      Object.assign(set, edgeEnds(options));
      const cleared = splitUnset((options.unset as string[] | undefined) ?? []);
      const unset = cleared.unset;
      const style = cleared.style === null ? null : { ...(cleared.style ?? {}), ...anyStyle(options) };
      const { icon, ops: before } = await iconFromOptions(options, readText);
      const kite: Record<string, unknown> = {};
      if (style === null || Object.keys(style).length) kite.style = style;
      if (icon) kite.icon = icon;
      else if (cleared.icon === null) kite.icon = null;
      if (Object.keys(kite).length) set.kite = kite;
      if (Object.keys(set).length === 0 && unset.length === 0) {
        throw new CliError('INVALID_PARAMS', 'Nothing to change', 'Give --text, --link, --label, --color, --from-side, --to-side, a style or icon flag, or --unset');
      }
      await change(reference, [...before, { op: 'update', id, set, ...(unset.length ? { unset } : {}) }], options, 'change a canvas');
    })),
    `Examples:

  agentio kite canvas update art_abc123 n1 --text "Ship on Friday"
  agentio kite canvas update art_abc123 e2 --label "blocks" --unset color
  agentio kite canvas update art_abc123 n1 --fill 2 --font serif --weight 600 --icon lucide:database
  agentio kite canvas update art_abc123 n1 --unset style.fill icon
  agentio kite canvas update art_abc123 e2 --color "#8a5cf6" --dashed --curve step --arrow both

Style changes merge with the style the node or edge already has.`,
  );

  addExamples(
    changeOptions(
      leaf(canvas, 'move', 'Move a node, or a group with everything in it, to x,y')
        .argument(...REF)
        .argument('<node-id>', 'The node or group')
        .argument('<x>', 'Left edge')
        .argument('<y>', 'Top edge'),
    ).action(run(async (reference: string, id: string, x: string, y: string, options) => {
      await change(reference, [{ op: 'move', id, x: parseNumber(x, 'x'), y: parseNumber(y, 'y') }], options, 'change a canvas');
    })),
    `Examples:

  agentio kite canvas move art_abc123 n1 400 120

  # a negative position: options first, then -- before the numbers
  agentio kite canvas move art_abc123 --json -- g1 -200 -80`,
  );

  addExamples(
    changeOptions(
      leaf(canvas, 'resize', 'Change a node\'s width and height')
        .argument(...REF)
        .argument('<node-id>', 'The node or group')
        .argument('<width>', 'Width')
        .argument('<height>', 'Height'),
    ).action(run(async (reference: string, id: string, width: string, height: string, options) => {
      await change(reference, [{ op: 'resize', id, width: parseNumber(width, 'width', 1), height: parseNumber(height, 'height', 1) }], options, 'change a canvas');
    })),
    `Examples:

  agentio kite canvas resize art_abc123 n1 320 160`,
  );

  addExamples(
    changeOptions(
      leaf(canvas, 'delete', 'Delete nodes (with their edges) or edges; a deleted group keeps what was inside')
        .argument(...REF)
        .argument('<ids...>', 'One or more node or edge ids'),
    ).action(run(async (reference: string, ids: string[], options) => {
      await change(reference, ids.map((id) => ({ op: 'delete', id })), options, 'change a canvas');
    })),
    `Examples:

  agentio kite canvas delete art_abc123 n4 n5

It is one new version; agentio kite canvas restore brings the old one back.`,
  );

  addExamples(
    changeOptions(edgeStyleFlags(
      leaf(canvas, 'connect', 'Join two nodes with an edge')
        .argument(...REF)
        .argument('<from>', 'The node it starts at')
        .argument('<to>', 'The node it points to')
        .option('--label <label>', 'Text on the edge')
        .option('--from-side <side>', 'The side it leaves from: top, right, bottom or left')
        .option('--to-side <side>', 'The side it arrives at'),
      { colour: true, labels: true })).action(run(async (reference: string, from: string, to: string, options) => {
      const op: CanvasOp = { op: 'connect', from, to, tempId: 'edge' };
      if (options.label !== undefined) op.label = options.label;
      if (options.fromSide !== undefined) op.fromSide = parseSide(options.fromSide, '--from-side');
      if (options.toSide !== undefined) op.toSide = parseSide(options.toSide, '--to-side');
      if (options.color !== undefined) op.color = options.color;
      Object.assign(op, edgeEnds(options));
      const style = edgeStyle(options);
      if (Object.keys(style).length) op.kite = { style };
      await change(reference, [op], options, 'change a canvas');
    })),
    `Examples:

  agentio kite canvas connect art_abc123 n1 n2 --label "then"
  agentio kite canvas connect art_abc123 n1 n2 --label "reads" --color 5 --dashed --curve step --line-width 2`,
  );

  addExamples(
    changeOptions(themeFlags(
      leaf(canvas, 'theme', 'Set the canvas theme: background, grid, and the default look of nodes, groups and edges')
        .argument(...REF),
    )).action(run(async (reference: string, options) => {
      const fromFile = options.from === undefined ? undefined : await readText(options.from);
      const theme = themeFromOptions(options, fromFile);
      await change(reference, [{ op: 'theme', set: theme }], options, 'change a canvas');
    })),
    `Examples:

  agentio kite canvas theme art_abc123 --background "#f7f5ef" --grid dots --font inter --radius 12 --curve step
  agentio kite canvas theme art_abc123 --group-fill "#ffffff80" --label-font grotesk --label-weight 700
  agentio kite canvas theme art_abc123 --from theme.json
  agentio kite canvas theme art_abc123 --reset

The box and text flags (--fill, --font, …) set the default for cards; --group-*
and the --label-* flags for groups; the line flags and --edge-color for edges.
A theme merges with the one the canvas has; a node's own style wins over it.`,
  );

  addExamples(
    changeOptions(
      leaf(canvas, 'disconnect', 'Remove an edge')
        .argument(...REF)
        .argument('<edge-id>', 'The edge'),
    ).action(run(async (reference: string, id: string, options) => {
      await change(reference, [{ op: 'disconnect', id }], options, 'change a canvas');
    })),
    `Examples:

  agentio kite canvas disconnect art_abc123 e3`,
  );

  const versions = canvas.command('versions').description('Earlier versions of one of your canvases');

  addExamples(
    leaf(versions, 'list', 'List every version of a canvas, newest first', { isDefault: true })
      .argument(...REF)
      .action(run(async (reference: string, options) => {
        const { client } = await getKiteClient(options.profile);
        printVersions(await client.versions(reference), options.json);
      })),
    `Examples:

  agentio kite canvas versions art_abc123`,
  );

  addExamples(
    leaf(versions, 'get', 'Read one version of a canvas as it was, as JSON')
      .argument(...REF)
      .argument('<version>', 'The version number, from agentio kite canvas versions')
      .option('--out <file>', 'Write nodes and edges to this file instead of printing them')
      .action(run(async (reference: string, version: string, options) => {
        const n = parseVersion(version);
        const out = options.out !== undefined ? await checkOutPath(options.out) : undefined;
        const { client } = await getKiteClient(options.profile);
        const old: CanvasVersion = await new KiteCanvas(client).version(reference, n);
        if (out) {
          try { await writeFile(out, `${JSON.stringify({ nodes: old.nodes, edges: old.edges }, null, 2)}\n`); } catch { throw new CliError('INVALID_PARAMS', `Cannot write ${options.out}`); }
          emit(options.json, { id: old.id, version: old.version, currentVersion: old.currentVersion, file: out },
            () => console.log(`${old.id}, version ${old.version} of ${old.currentVersion}, written to ${out}`));
          return;
        }
        writeJson(old, 2);
      })),
    `Examples:

  agentio kite canvas versions get art_abc123 3
  agentio kite canvas versions get art_abc123 3 --out v3.canvas

Reading a version is not recorded: it is neither a view nor an agent read.`,
  );

  addExamples(
    leaf(canvas, 'restore', 'Make an earlier version the current one again, as a new version')
      .argument(...REF)
      .argument('<version>', 'The version to bring back')
      .option(...BASE)
      .action(run(async (reference: string, version: string, options) => {
        const n = parseVersion(version);
        const client = await getWritableClient(options.profile, 'restore a canvas');
        const doc = await new KiteCanvas(client).restore(reference, n, optionalVersion(options.baseVersion));
        emit(options.json, doc, () => console.log(`${doc.id} is at version ${doc.version} now, the same as version ${doc.restoredFrom}.`));
      })),
    `Examples:

  agentio kite canvas restore art_abc123 3

Nothing is lost: the versions after it stay in the history. Comments stay on
the nodes they were on.`,
  );
}
