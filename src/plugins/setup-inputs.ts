import { normaliseServerUrl } from '../utils/base-url';
import { CliError } from '../utils/errors';
import type { InputSpec, SetupContext } from '../plugin-sdk';

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
    // The rule every server URL follows (https when no scheme is given); the message names the input.
    try {
      return normaliseServerUrl(text, spec.label, 'https://example.com');
    } catch {
      throw invalid(`${spec.label} must be an http or https address`);
    }
  }
  if (spec.kind === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) throw invalid(`${spec.label} must be an email address`);
  if (spec.kind === 'choice') {
    const values = (spec.choices ?? []).map((c) => c.value);
    if (!values.includes(text)) throw invalid(`${spec.label} must be one of: ${values.join(', ')}`);
  }
  return text;
}

/** The value given with a flag, checked, or else the answer to the question `spec` asks. */
export async function answerOrAsk(context: SetupContext, spec: InputSpec, given: string | undefined): Promise<string> {
  return given !== undefined ? checkAnswer(spec, given) : await context.ask(spec);
}
