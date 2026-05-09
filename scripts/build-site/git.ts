import { $ } from 'bun';

export interface VersionTag {
  name: string;
  date: string;
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

export async function listVersionTags(): Promise<VersionTag[]> {
  const out = await $`git for-each-ref --sort=-creatordate --format=%(refname:short)|%(creatordate:iso-strict) refs/tags`.text();
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, date] = l.split('|');
      return { name, date };
    })
    .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t.name));
}

function parseLog(out: string): Commit[] {
  return out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, ...rest] = entry.split('\t');
      return { sha, subject: subject ?? '', body: rest.join('\t') };
    });
}

export async function listCommitsBetween(from: string, to: string): Promise<Commit[]> {
  const range = `${from}..${to}`;
  const out = await $`git log ${range} --format=%h%x09%s%x09%b%x1e`.text();
  return parseLog(out);
}

export async function listCommitsUpTo(ref: string): Promise<Commit[]> {
  const out = await $`git log ${ref} --format=%h%x09%s%x09%b%x1e`.text();
  return parseLog(out);
}
