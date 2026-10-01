import { CliError } from './errors';

/**
 * A server URL as a profile stores it: scheme required (https added when
 * absent), http(s) only, no credentials, no trailing slash. `service` and
 * `example` only shape the error messages.
 */
export function normaliseServerUrl(input: string, service: string, example: string): string {
  const hint = `Example: --url ${example}`;
  const trimmed = input.trim();
  if (!trimmed) throw new CliError('INVALID_PARAMS', `The ${service} URL is required`, hint);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CliError('INVALID_PARAMS', `Not a valid ${service} URL: ${input}`, hint);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError('INVALID_PARAMS', `A ${service} URL must use https or http, not ${url.protocol.slice(0, -1)}`);
  }
  if (!url.hostname || url.username || url.password) {
    throw new CliError('INVALID_PARAMS', `Not a valid ${service} URL: ${input}`, hint);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}
