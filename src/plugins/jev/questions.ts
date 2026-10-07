import { CliError } from '../../utils/errors';
import type { JevState } from './types';

const invalid = (message: string, suggestion?: string) => new CliError('INVALID_PARAMS', message, suggestion);

/** `--threshold`: a plain number from 0 to 1. */
export function parseThreshold(text: string): number {
  const value = text.trim();
  if (!/^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(value)) {
    throw invalid(`--threshold must be a number from 0 to 1, not "${text}"`);
  }
  return Number(value);
}

/** `--option key=description`, repeated: 2 to 255 distinct keys. */
export function parseOptions(values: string[]): Record<string, string> {
  if (values.length < 2) throw invalid('A choice needs at least two --option values', 'Pass --option key="description" for each option');
  if (values.length > 255) throw invalid('A choice takes at most 255 options');
  const options: Record<string, string> = {};
  for (const raw of values) {
    const at = raw.indexOf('=');
    const key = at < 0 ? '' : raw.slice(0, at).trim();
    const description = at < 0 ? '' : raw.slice(at + 1).trim();
    if (!key || !description) throw invalid(`--option must be key=description, not "${raw}"`);
    if (Object.hasOwn(options, key)) throw invalid(`--option "${key}" is given twice`);
    options[key] = description;
  }
  return options;
}

/** `--level`, repeated: 2 to 10 descriptions, lowest first. */
export function parseLevels(values: string[]): string[] {
  if (values.length < 2 || values.length > 10) throw invalid('A score needs 2 to 10 --level values, lowest first');
  return values.map((raw) => {
    const level = raw.trim();
    if (!level) throw invalid('A --level cannot be blank');
    return level;
  });
}

/** The state: a JSON object or array when it parses as one, else the text itself. */
export function parseState(text: string): JevState {
  const value = text.trim();
  if (!value) throw invalid('No input to evaluate', 'Pipe it on stdin, or pass --state <text>');
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) return parsed as JevState;
    } catch {
      // Not JSON after all: sent as text.
    }
  }
  return value;
}

export function requireQuestion(text: string): string {
  const question = text.trim();
  if (!question) throw invalid('The question cannot be blank');
  return question;
}
