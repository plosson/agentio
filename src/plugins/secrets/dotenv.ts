import { CliError } from '../../utils/errors';
import { validateKey } from './store';

const ESCAPES: Record<string, string> = { n: '\n', '"': '"', '\\': '\\' };

/**
 * Read a dotenv file into a map, the last of duplicate keys winning. Any line
 * it cannot read fails the whole file, so an import writes all or nothing.
 * Errors name the line, never its value.
 */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const fail = (reason: string) => new CliError('INVALID_PARAMS', `Cannot read line ${index + 1}: ${reason}`, 'Each line must be KEY=value');

    const assignment = line.replace(/^export\s+/, '');
    const equals = assignment.indexOf('=');
    if (equals === -1) throw fail('no "="');
    const key = assignment.slice(0, equals).trim();
    try {
      validateKey(key);
    } catch {
      throw fail(`invalid name "${key}"`);
    }
    values.set(key, readValue(assignment.slice(equals + 1).trimStart(), fail));
  });
  return values;
}

function readValue(rest: string, fail: (reason: string) => CliError): string {
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") {
    const comment = rest.search(/\s#/);
    return (comment === -1 ? rest : rest.slice(0, comment)).trim();
  }

  let value = '';
  for (let i = 1; i < rest.length; i++) {
    const char = rest[i]!;
    if (char === quote) {
      if (!/^(\s*|\s+#.*)$/.test(rest.slice(i + 1))) throw fail('text after the closing quote');
      return value;
    }
    if (quote === '"' && char === '\\' && i + 1 < rest.length) {
      const next = rest[++i]!;
      value += ESCAPES[next] ?? `\\${next}`;
      continue;
    }
    value += char;
  }
  throw fail('no closing quote');
}
