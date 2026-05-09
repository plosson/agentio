export interface VersionTag {
  name: string;
  date: string;
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(' ')} failed: ${err}`);
  }
  return out;
}

export async function listVersionTags(): Promise<VersionTag[]> {
  const out = await git([
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname:short)|%(creatordate:iso-strict)',
    'refs/tags',
  ]);
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
  const out = await git(['log', `${from}..${to}`, '--format=%h%x09%s%x09%b%x1e']);
  return parseLog(out);
}

export async function listCommitsUpTo(ref: string): Promise<Commit[]> {
  const out = await git(['log', ref, '--format=%h%x09%s%x09%b%x1e']);
  return parseLog(out);
}
