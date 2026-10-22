import { isAbsolute, relative, resolve, sep } from 'path';
import { CliError } from './errors';

/**
 * Resolve `name` against `baseDir` and refuse anything that lands outside it
 * (`../x`, an absolute path, or the directory itself). Use it before writing a
 * file whose name came from a remote source (an email, a shared project, ...).
 */
export function resolveInside(baseDir: string, name: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, name);
  const rel = relative(base, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CliError('INVALID_PARAMS', `Refusing to write outside ${baseDir}: ${JSON.stringify(name)}`);
  }
  return target;
}
