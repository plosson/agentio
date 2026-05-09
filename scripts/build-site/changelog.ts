import type { Commit } from './git';

export interface ParsedCommit {
  type: string;
  scope?: string;
  subject: string;
  isVersionBump?: boolean;
}

export interface ParsedEntry extends ParsedCommit {
  sha: string;
}

export interface ReleaseGroups {
  features: ParsedEntry[];
  fixes: ParsedEntry[];
  internal: ParsedEntry[];
}

const RE = /^(feat|fix|chore|docs|refactor|test|perf|style|build|ci)(\(([^)]+)\))?: (.+)$/;
const VERSION_BUMP_RE = /^bump version to/i;

export function parseConventional(subject: string): ParsedCommit | null {
  const m = subject.match(RE);
  if (!m) return null;
  const [, type, , scope, rest] = m;
  const result: ParsedCommit = {
    type,
    scope: scope || undefined,
    subject: rest,
  };
  if (type === 'chore' && VERSION_BUMP_RE.test(rest)) {
    result.isVersionBump = true;
  }
  return result;
}

export function groupReleases(commits: Commit[]): ReleaseGroups {
  const features: ParsedEntry[] = [];
  const fixes: ParsedEntry[] = [];
  const internal: ParsedEntry[] = [];

  for (const c of commits) {
    const parsed = parseConventional(c.subject);
    if (!parsed) continue;
    if (parsed.isVersionBump) continue;
    const entry: ParsedEntry = { ...parsed, sha: c.sha };
    if (parsed.type === 'feat') features.push(entry);
    else if (parsed.type === 'fix') fixes.push(entry);
    else internal.push(entry);
  }

  return { features, fixes, internal };
}
