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
 * Get the default branch for a repository.
 */
export async function getDefaultBranch(
  owner: string,
  repo: string
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'agentio-plugin-manager',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new CliError('NOT_FOUND', `Repository not found: ${owner}/${repo}`);
    }
    throw new CliError('API_ERROR', `GitHub API error: ${response.statusText}`);
  }

  const data = (await response.json()) as { default_branch: string };
  return data.default_branch;
}

/**
 * Build the GitHub API URL for contents.
 */
export function getContentsUrl(
  parsed: ParsedSource,
  subPath?: string
): string {
  const basePath = parsed.path ? `${parsed.path}` : '';
  const fullPath = subPath
    ? basePath
      ? `${basePath}/${subPath}`
      : subPath
    : basePath;

  let url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents`;
  if (fullPath) {
    url += `/${fullPath}`;
  }
  if (parsed.branch) {
    url += `?ref=${parsed.branch}`;
  }
  return url;
}
