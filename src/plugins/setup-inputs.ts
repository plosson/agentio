import { CliError } from '../utils/errors';
import type { InputSpec, SetupNeeds } from '../plugin-sdk';

const invalid = (message: string) => new CliError('INVALID_PARAMS', message);

/** One value checked against its spec: text, trimmed, present when required, of its kind. */
export function checkAnswer(spec: InputSpec, value: unknown): string {
  if (typeof value !== 'string') throw invalid(`${spec.label} must be text`);
  const text = value.trim();
  if (!text) {
    if (spec.required === false) return '';
    throw invalid(`${spec.label} is required`);
  }
  if (spec.kind === 'url') {
    // No scheme means https (as the terminal always did); `host:port` is a host, `mailto:x` is not.
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
    const otherScheme = !hasScheme && /^[a-z][a-z0-9+.-]*:(?!\d+(\/|$))/i.test(text);
    const completed = hasScheme ? text : `https://${text}`;
    let protocol = '';
    try { protocol = new URL(completed).protocol; } catch { /* not a URL */ }
    if (otherScheme || (protocol !== 'http:' && protocol !== 'https:')) throw invalid(`${spec.label} must be an http or https address`);
    return completed;
  }
  if (spec.kind === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) throw invalid(`${spec.label} must be an email address`);
  if (spec.kind === 'choice') {
    const values = (spec.choices ?? []).map((c) => c.value);
    if (!values.includes(text)) throw invalid(`${spec.label} must be one of: ${values.join(', ')}`);
  }
  return text;
}

function parseObject(line: string | null): Record<string, unknown> | null {
  if (line === null) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `--input -` line: known ids only, each value checked. Missing values are asked later. */
export function readInputs(line: string | null, needs: SetupNeeds): Record<string, string> {
  const object = parseObject(line);
  if (!object) throw invalid('Expected the setup values as one JSON object on the first line of stdin');
  const values: Record<string, string> = {};
  for (const id of Object.keys(object)) {
    const spec = needs.inputs.find((input) => input.id === id);
    if (!spec) throw invalid(`Unknown setup value "${id}"`);
    values[id] = checkAnswer(spec, object[id]);
  }
  return values;
}

/** One answer line, `{"id","value"}`, for the question `spec` asked. */
export function parseAnswer(line: string | null, spec: InputSpec): string {
  if (line === null) throw invalid(`No answer for "${spec.label}"`);
  const object = parseObject(line);
  if (!object) throw invalid(`Expected an answer for "${spec.id}" as {"id","value"}`);
  if (object.id !== spec.id) {
    throw invalid(`Expected an answer for "${spec.id}", got ${typeof object.id === 'string' ? `"${object.id}"` : 'nothing'}`);
  }
  return checkAnswer(spec, object.value);
}
