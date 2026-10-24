/**
 * How a canvas looks, from the command line: style, icon and theme flags
 * turned into the `kite` fields of Kite's canvas operations.
 *
 * Kite checks every value again; the checks here catch a typo before any
 * request and say what would have been accepted.
 */

import { Command } from 'commander';
import { basename } from 'path';
import { CliError } from '../../utils/errors';
import { parseNumber, type CanvasOp } from './canvas';

export const FONTS = ['sans', 'inter', 'grotesk', 'serif', 'mono', 'hand'] as const;
export const WEIGHTS = [300, 400, 500, 600, 700, 800] as const;
const LINES = ['solid', 'dashed', 'dotted'] as const;
const CURVES = ['bezier', 'straight', 'step'] as const;
const ARROWS = ['end', 'start', 'both', 'none'] as const;
const GRIDS = ['dots', 'lines', 'cross', 'none'] as const;
const COLOUR_HINT = 'Use a preset 1–6, a hex colour like #ff8800 (or #ff880080), or transparent.';

type Options = Record<string, unknown>;
type Style = Record<string, unknown>;

export function parseColour(value: unknown, flag: string): string {
  const text = String(value);
  if (/^[1-6]$/.test(text) || /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(text) || text === 'transparent') return text;
  throw new CliError('INVALID_PARAMS', `Not a colour for ${flag}: ${text}`, COLOUR_HINT);
}

function oneOf<T extends string | number>(choices: readonly T[], value: unknown, flag: string): T {
  const found = choices.find((c) => String(c) === String(value));
  if (found === undefined) throw new CliError('INVALID_PARAMS', `Not a value for ${flag}: ${String(value)}`, `Use one of ${choices.join(', ')}.`);
  return found;
}

function whole(value: unknown, flag: string, min: number, max: number): number {
  const n = parseNumber(value, flag);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError('INVALID_PARAMS', `Not a value for ${flag}: ${String(value)}`, `Give a whole number from ${min} to ${max}.`);
  return n;
}

/** One flag: its option name in commander's camelCase, the style key it sets, and how it is read. */
interface Flag {
  option: string;
  flag: string;
  key: string;
  read: (value: unknown, flag: string) => unknown;
  help: string;
}

const colour = (value: unknown, flag: string) => parseColour(value, flag);
const font = (value: unknown, flag: string) => oneOf(FONTS, value, flag);
const weight = (value: unknown, flag: string) => oneOf(WEIGHTS, value, flag);
const range = (min: number, max: number) => (value: unknown, flag: string) => whole(value, flag, min, max);

const BOX_FLAGS: Flag[] = [
  { option: 'fill', flag: '--fill <color>', key: 'fill', read: colour, help: 'Fill colour: 1–6, #rrggbb, #rrggbbaa or transparent' },
  { option: 'border', flag: '--border <color>', key: 'borderColor', read: colour, help: 'Border colour' },
  { option: 'borderWidth', flag: '--border-width <n>', key: 'borderWidth', read: range(0, 16), help: 'Border width, 0 to 16 (0: none)' },
  { option: 'borderStyle', flag: '--border-style <style>', key: 'borderStyle', read: (v, f) => oneOf(LINES, v, f), help: 'solid, dashed or dotted' },
  { option: 'radius', flag: '--radius <n>', key: 'radius', read: range(0, 96), help: 'Corner radius, 0 to 96' },
  { option: 'shadow', flag: '--shadow <size>', key: 'shadow', read: (v, f) => oneOf(['none', 'sm', 'md', 'lg'], v, f), help: 'none, sm, md or lg' },
  { option: 'textColor', flag: '--text-color <color>', key: 'textColor', read: colour, help: 'Text colour' },
  { option: 'font', flag: '--font <font>', key: 'font', read: font, help: `Font: ${FONTS.join(', ')}` },
  { option: 'fontSize', flag: '--font-size <n>', key: 'fontSize', read: range(8, 96), help: 'Text size, 8 to 96' },
  { option: 'weight', flag: '--weight <n>', key: 'fontWeight', read: weight, help: `Text weight: ${WEIGHTS.join(', ')}` },
  { option: 'align', flag: '--align <align>', key: 'textAlign', read: (v, f) => oneOf(['left', 'center', 'right'], v, f), help: 'left, center or right' },
  { option: 'valign', flag: '--valign <align>', key: 'verticalAlign', read: (v, f) => oneOf(['top', 'middle', 'bottom'], v, f), help: 'top, middle or bottom' },
];

/** A group's name, or an edge's label. */
const LABEL_FLAGS: Flag[] = [
  { option: 'labelColor', flag: '--label-color <color>', key: 'labelColor', read: colour, help: 'Label colour (a group\'s name, an edge\'s label)' },
  { option: 'labelFont', flag: '--label-font <font>', key: 'labelFont', read: font, help: 'Label font' },
  { option: 'labelSize', flag: '--label-size <n>', key: 'labelSize', read: range(8, 96), help: 'Label size, 8 to 96' },
  { option: 'labelWeight', flag: '--label-weight <n>', key: 'labelWeight', read: weight, help: 'Label weight' },
  { option: 'labelBackground', flag: '--label-background <color>', key: 'labelBackground', read: colour, help: 'Label background' },
];

const LINE_FLAGS: Flag[] = [
  { option: 'lineWidth', flag: '--line-width <n>', key: 'width', read: range(1, 12), help: 'Edge width, 1 to 12' },
  { option: 'line', flag: '--line <style>', key: 'line', read: (v, f) => oneOf(LINES, v, f), help: 'Edge line: solid, dashed or dotted' },
  { option: 'curve', flag: '--curve <curve>', key: 'curve', read: (v, f) => oneOf(CURVES, v, f), help: 'Edge shape: bezier, straight or step' },
];

function addFlags(command: Command, flags: Flag[]): Command {
  for (const f of flags) command.option(f.flag, f.help);
  return command;
}

function flagName(f: Flag): string {
  return f.flag.split(' ')[0]!;
}

function read(options: Options, flags: Flag[]): Style {
  const style: Style = {};
  for (const f of flags) if (options[f.option] !== undefined) style[f.key] = f.read(options[f.option], flagName(f));
  return style;
}

/** Style flags for a node or a group: the box, the text and a group's name. */
export function nodeStyleFlags(command: Command): Command {
  return addFlags(command, [...BOX_FLAGS, ...LABEL_FLAGS]);
}

export function iconFlags(command: Command): Command {
  return command
    .option('--icon <name>', 'An icon: lucide:<name> (any Lucide icon, such as lucide:server) or asset:<id> (a custom SVG already on the canvas)')
    .option('--icon-svg <file>', 'A custom SVG icon from this file (- for stdin); Kite cleans it and keeps it on the canvas')
    .option('--icon-position <where>', 'left of the text (default) or top, large above it')
    .option('--icon-size <n>', 'Icon size, 12 to 160')
    .option('--icon-color <color>', 'Icon colour, for Lucide icons');
}

/** Style flags for an edge. --dashed and --dotted are short for --line. */
export function edgeStyleFlags(command: Command, options: { colour: boolean; labels: boolean }): Command {
  if (options.labels) addFlags(command, LABEL_FLAGS);
  addFlags(command, LINE_FLAGS)
    .option('--dashed', 'A dashed edge (--line dashed)')
    .option('--dotted', 'A dotted edge (--line dotted)')
    .option('--arrow <ends>', 'Arrowheads: end (the default look), start, both or none');
  if (options.colour) command.option('--color <color>', 'Edge colour: 1–6 or #rrggbb');
  return command;
}

export function nodeStyle(options: Options): Style {
  return read(options, [...BOX_FLAGS, ...LABEL_FLAGS]);
}

/** An edge's line: width, line style (or --dashed / --dotted) and curve. */
function lineStyle(options: Options): Style {
  const style = read(options, LINE_FLAGS);
  const shortcuts = (['dashed', 'dotted'] as const).filter((k) => options[k]);
  if (shortcuts.length + (options.line === undefined ? 0 : 1) > 1) {
    throw new CliError('INVALID_PARAMS', 'Give one of --line, --dashed or --dotted');
  }
  if (shortcuts.length) style.line = shortcuts[0];
  return style;
}

export function edgeStyle(options: Options): Style {
  return { ...lineStyle(options), ...read(options, LABEL_FLAGS) };
}

/** For update, which may name a node or an edge: every style flag; Kite refuses keys that do not fit. */
export function anyStyle(options: Options): Style {
  return { ...nodeStyle(options), ...lineStyle(options) };
}

/** The spec's own edge fields: arrow ends. */
export function edgeEnds(options: Options): { fromEnd?: 'none' | 'arrow'; toEnd?: 'none' | 'arrow' } {
  if (options.arrow === undefined) return {};
  const ends = oneOf(ARROWS, options.arrow, '--arrow');
  return {
    fromEnd: ends === 'start' || ends === 'both' ? 'arrow' : 'none',
    toEnd: ends === 'end' || ends === 'both' ? 'arrow' : 'none',
  };
}

function iconGiven(options: Options): boolean {
  return ['icon', 'iconSvg', 'iconPosition', 'iconSize', 'iconColor'].some((k) => options[k] !== undefined);
}

/** The tempId an --icon-svg upload gets in its batch. */
export const ICON_ASSET = 'icon';

/**
 * The icon the flags ask for, and the addAsset to send first when it is a
 * custom SVG. `readText` reads the file (or stdin for -).
 */
export async function iconFromOptions(options: Options, readText: (path: string) => Promise<string>): Promise<{ icon?: Record<string, unknown>; ops: CanvasOp[] }> {
  if (!iconGiven(options)) return { ops: [] };
  if (options.icon !== undefined && options.iconSvg !== undefined) throw new CliError('INVALID_PARAMS', 'Give --icon or --icon-svg, not both');
  if (options.icon === undefined && options.iconSvg === undefined) {
    throw new CliError('INVALID_PARAMS', 'Which icon?', 'Give --icon lucide:<name> or --icon-svg <file> with --icon-position, --icon-size or --icon-color');
  }
  const icon: Record<string, unknown> = {};
  const ops: CanvasOp[] = [];
  if (options.icon !== undefined) {
    const name = String(options.icon);
    if (!/^(lucide|asset):[A-Za-z0-9_-]+$/.test(name)) {
      throw new CliError('INVALID_PARAMS', `Not an icon: ${name}`, 'Use lucide:<name>, such as lucide:server (see https://lucide.dev/icons), or asset:<id> for a custom SVG on the canvas.');
    }
    icon.name = name;
  } else {
    const path = String(options.iconSvg);
    const svg = await readText(path);
    ops.push({ op: 'addAsset', tempId: ICON_ASSET, svg, ...(path === '-' ? {} : { name: basename(path).replace(/\.svg$/i, '') }) });
    icon.name = `asset:${ICON_ASSET}`;
  }
  if (options.iconPosition !== undefined) icon.position = oneOf(['left', 'top'], options.iconPosition, '--icon-position');
  if (options.iconSize !== undefined) icon.size = whole(options.iconSize, '--icon-size', 12, 160);
  if (options.iconColor !== undefined) {
    if (String(icon.name).startsWith('asset:')) throw new CliError('INVALID_PARAMS', '--icon-color is for Lucide icons', 'A custom SVG keeps its own colours.');
    icon.color = parseColour(options.iconColor, '--icon-color');
  }
  return { icon, ops };
}

/**
 * `--unset` names: spec fields go to the update's `unset`; `style` and
 * `icon` remove the whole style or icon; `style.<key>` one style key.
 */
export function splitUnset(names: string[]): { unset: string[]; style?: Style | null; icon?: null } {
  const unset: string[] = [];
  let style: Style | null | undefined;
  let icon: null | undefined;
  for (const name of names) {
    if (name === 'style') style = null;
    else if (name === 'icon') icon = null;
    else if (name.startsWith('style.')) {
      const key = name.slice('style.'.length);
      if (!/^[A-Za-z]+$/.test(key)) throw new CliError('INVALID_PARAMS', `Not a style key: ${key}`);
      if (style !== null) style = { ...(style ?? {}), [key]: null };
    } else unset.push(name);
  }
  return { unset, ...(style === undefined ? {} : { style }), ...(icon === undefined ? {} : { icon }) };
}

// ---------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------

export function themeFlags(command: Command): Command {
  command
    .option('--background <color>', 'The canvas background')
    .option('--grid <grid>', `The grid: ${GRIDS.join(', ')}`)
    .option('--grid-color <color>', 'The grid colour');
  addFlags(command, BOX_FLAGS);
  command
    .option('--group-fill <color>', 'Groups: fill')
    .option('--group-border <color>', 'Groups: border colour');
  addFlags(command, LABEL_FLAGS);
  addFlags(command, LINE_FLAGS)
    .option('--dashed', 'Edges: dashed')
    .option('--dotted', 'Edges: dotted')
    .option('--edge-color <color>', 'Edges: the colour of an edge that names none')
    .option('--from <file>', 'A theme as JSON ({"background", "grid", "gridColor", "node", "group", "edge"}), merged before the flags')
    .option('--reset', 'Remove the theme: back to Kite\'s own look');
  return command;
}

const isObject = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null && !Array.isArray(d);

/** Merge b into a, one level into node, group and edge. */
function mergeTheme(a: Style, b: Style): Style {
  const out: Style = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObject(v) && isObject(out[k]) ? { ...(out[k] as Style), ...v } : v;
  return out;
}

/**
 * The theme patch the flags make: canvas fields, node defaults from the box
 * flags, group defaults from --group-* and the label flags, edge defaults
 * from the line flags. `null` (from --reset) removes the theme.
 */
export function themeFromOptions(options: Options, fromFile?: string): Style | null {
  const flagged = [...BOX_FLAGS, ...LABEL_FLAGS, ...LINE_FLAGS].some((f) => options[f.option] !== undefined)
    || ['background', 'grid', 'gridColor', 'groupFill', 'groupBorder', 'dashed', 'dotted', 'edgeColor'].some((k) => options[k] !== undefined);
  if (options.reset) {
    if (flagged || fromFile !== undefined) throw new CliError('INVALID_PARAMS', '--reset removes the theme; give it on its own');
    return null;
  }
  let theme: Style = {};
  if (fromFile !== undefined) {
    let data: unknown;
    try { data = JSON.parse(fromFile); } catch { throw new CliError('INVALID_PARAMS', 'The --from file is not JSON'); }
    if (!isObject(data)) throw new CliError('INVALID_PARAMS', 'The --from file is not a theme', 'A theme is an object: {"background": "#f7f5ef", "node": {"font": "inter"}, ...}');
    theme = data;
  }
  const own: Style = {};
  if (options.background !== undefined) own.background = parseColour(options.background, '--background');
  if (options.grid !== undefined) own.grid = oneOf(GRIDS, options.grid, '--grid');
  if (options.gridColor !== undefined) own.gridColor = parseColour(options.gridColor, '--grid-color');
  const node = read(options, BOX_FLAGS);
  if (Object.keys(node).length) own.node = node;
  const group = read(options, LABEL_FLAGS);
  if (options.groupFill !== undefined) group.fill = parseColour(options.groupFill, '--group-fill');
  if (options.groupBorder !== undefined) group.borderColor = parseColour(options.groupBorder, '--group-border');
  if (Object.keys(group).length) own.group = group;
  const edge = lineStyle(options);
  if (options.edgeColor !== undefined) edge.color = parseColour(options.edgeColor, '--edge-color');
  if (Object.keys(edge).length) own.edge = edge;
  theme = mergeTheme(theme, own);
  if (Object.keys(theme).length === 0) throw new CliError('INVALID_PARAMS', 'Nothing to change', 'Give theme flags such as --background, --grid, --font or --edge-color, --from <file>, or --reset');
  return theme;
}
