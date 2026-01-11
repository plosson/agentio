import { CliError } from '../../utils/errors';
import type { ParsedSource } from '../../types/claude-plugin';

/**
 * Parse various GitHub source formats into a normalized ParsedSource.
 *
 * Supported formats:
 * - https://github.com/owner/repo/tree/branch/path
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - owner/repo
 * - owner/repo/path/to/plugin
 */
export function parseSource(source: string): ParsedSource {
  // Full GitHub tree URL: https://github.com/owner/repo/tree/branch/path
  if (source.includes('github.com') && source.includes('/tree/')) {
    return parseGitHubTreeUrl(source);
  }

  // SSH URL: git@github.com:owner/repo.git
  if (source.startsWith('git@')) {
    return parseSshUrl(source);
  }

  // HTTPS clone URL: https://github.com/owner/repo.git
  if (source.includes('github.com') && source.endsWith('.git')) {
    return parseHttpsCloneUrl(source);
  }

  // Plain GitHub URL without tree: https://github.com/owner/repo or https://github.com/owner/repo/path
  if (source.includes('github.com')) {
    return parseGitHubUrl(source);
  }

  // Short form: owner/repo or owner/repo/path
  return parseShortForm(source);
}

function parseGitHubTreeUrl(url: string): ParsedSource {
  // https://github.com/owner/repo/tree/branch/path/to/plugin
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?/
  );
  if (!match) {
    throw new CliError('INVALID_PARAMS', `Invalid GitHub tree URL: ${url}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    branch: match[3],
    path: match[4] || undefined,
  };
}

function parseSshUrl(url: string): ParsedSource {
  // git@github.com:owner/repo.git
  const match = url.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new CliError('INVALID_PARAMS', `Invalid SSH URL: ${url}`);
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

function parseHttpsCloneUrl(url: string): ParsedSource {
  // https://github.com/owner/repo.git
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)\.git$/);
  if (!match) {
    throw new CliError('INVALID_PARAMS', `Invalid HTTPS clone URL: ${url}`);
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

function parseGitHubUrl(url: string): ParsedSource {
  // https://github.com/owner/repo or https://github.com/owner/repo/path
  const match = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\/(.+))?$/);
  if (!match) {
    throw new CliError('INVALID_PARAMS', `Invalid GitHub URL: ${url}`);
  }
  return {
    owner: match[1],
    repo: match[2],
    path: match[3] || undefined,
  };
}

function parseShortForm(source: string): ParsedSource {
  // owner/repo or owner/repo/path/to/plugin
  const parts = source.split('/');
  if (parts.length < 2) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid source format: ${source}`,
      'Use owner/repo or a GitHub URL'
    );
  }
  return {
    owner: parts[0],
    repo: parts[1],
    path: parts.length > 2 ? parts.slice(2).join('/') : undefined,
  };
}

/**
 * Build a git clone URL from parsed source.
 */
export function buildGitCloneUrl(parsed: ParsedSource): string {
  return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
}
