import type { Command } from 'commander';
import { homedir } from 'os';
import { format } from 'util';

/** Replace $HOME prefix with `~` for display. */
export function abbrHome(p: string, home: string = homedir()): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/**
 * Make console.error and console.warn print in bold on a terminal, and as
 * plain text elsewhere or with NO_COLOR. Bun prints them in red (or yellow),
 * but agentio's stderr also carries progress and instructions ("Waiting for
 * approval…"), which then look like errors.
 */
export function boldStderr(
  stream: { write(text: string): unknown; isTTY?: boolean } = process.stderr,
  env: Record<string, string | undefined> = process.env,
): void {
  const bold = stream.isTTY === true && !env.NO_COLOR;
  const write = (...args: unknown[]): void => {
    const text = format(...args);
    stream.write((bold && text !== '' ? `\x1b[1m${text}\x1b[22m` : text) + '\n');
  };
  console.error = write;
  console.warn = write;
}

/** Version of the `--json` output format; every printed object carries it as `v`. */
export const JSON_OUTPUT_VERSION = 1;

const JSON_COMMANDS = new WeakSet<Command>();
let jsonMode = false;

/**
 * Add `--json` to a command whose output programs read. Only commands added
 * here switch errors to JSON, so a service's own `--json [file]` input option
 * never does.
 */
export function addJsonOption(cmd: Command, description = 'Output JSON for programs to read'): Command {
  JSON_COMMANDS.add(cmd);
  return cmd.option('--json', description);
}

/**
 * Turn on JSON mode when `cmd` was added through `addJsonOption` and `--json`
 * was passed. Stdout then carries only what `writeJson` writes: any other log,
 * from the command or the code under it, goes to stderr.
 */
export function enterJsonMode(cmd: Command): void {
  if (!JSON_COMMANDS.has(cmd) || cmd.opts().json !== true) return;
  jsonMode = true;
  console.log = console.error;
  console.info = console.error;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Write JSON text to stdout, bypassing console.log, which JSON mode sends to stderr. */
export function writeJson(value: unknown, space?: number): void {
  process.stdout.write(JSON.stringify(value, null, space) + '\n');
}

/** Print one JSON object on its own line of stdout, tagged with the output version. */
export function printJson(object: Record<string, unknown>): void {
  writeJson({ v: JSON_OUTPUT_VERSION, ...object });
}
