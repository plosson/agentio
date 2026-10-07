import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/** The environment variables every fake records; `null` when unset. */
const WATCHED = [
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL', 'CODEX_AUTHAPI_BASE_URL', 'CODEX_APP_SERVER_CHATGPT_BASE_URL', 'CODEX_CLOUD_TASKS_BASE_URL', 'CODEX_OSS_BASE_URL', 'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL', 'CODEX_AGENT_IDENTITY_JWKS_BASE_URL', 'CODEX_REFRESH_TOKEN_URL_OVERRIDE', 'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
];

export interface FakeCall {
  args: string[];
  env: Record<string, string | null>;
  cwd: string;
  filesAtStart: string[];
  stdin: string;
  /** What `$CODEX_HOME` held while the fake ran. */
  codexHome: { files: string[]; authJson: string | null };
}

export interface FakeCli {
  binDir: string;
  respond(response: { stdout?: string; stderr?: string; exit?: number; answer?: string; sleep?: number }): void;
  lastCall(): Promise<FakeCall>;
  restore(): Promise<void>;
}

/**
 * A stand-in for `claude` or `codex` on a temporary PATH. It records each argument, the watched
 * variables, its directory, what that directory held, stdin, and `$CODEX_HOME`; then prints what the
 * test set, writes `answer` to the file after `-o` (as `codex exec` does), and exits as told.
 * PATH keeps only /bin and /usr/bin besides the fake, so the real CLI can never run.
 */
export async function installFakeCli(name: string): Promise<FakeCli> {
  const binDir = await mkdtemp(join(tmpdir(), `agentio-fake-${name}-`));
  const logDir = join(binDir, 'log');
  const script = `#!/bin/sh
log="${logDir}"
rm -rf "$log"; mkdir -p "$log"
pwd -P > "$log/cwd"
ls -A > "$log/files"
i=0; out=""; take=0
for a in "$@"; do
  printf '%s' "$a" > "$log/arg.$i"; i=$((i+1))
  if [ "$take" = 1 ]; then out="$a"; take=0; fi
  if [ "$a" = "-o" ]; then take=1; fi
done
${WATCHED.map((v) => `if [ -n "\${${v}+x}" ]; then printf '%s' "$${v}" > "$log/env.${v}"; fi`).join('\n')}
if [ -n "$CODEX_HOME" ]; then ls -A "$CODEX_HOME" > "$log/codex-files"; [ -f "$CODEX_HOME/auth.json" ] && cp "$CODEX_HOME/auth.json" "$log/auth.json"; fi
cat > "$log/stdin"
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
[ -n "$out" ] && [ -n "$FAKE_ANSWER" ] && printf '%s' "$FAKE_ANSWER" > "$out"
printf '%s' "$FAKE_STDOUT"
printf '%s' "$FAKE_STDERR" >&2
exit "\${FAKE_EXIT:-0}"
`;
  await writeFile(join(binDir, name), script);
  await chmod(join(binDir, name), 0o755);

  const saved = { ...process.env };
  process.env.PATH = `${binDir}:/bin:/usr/bin`;

  const read = async (file: string) => (existsSync(join(logDir, file)) ? readFile(join(logDir, file), 'utf8') : null);
  return {
    binDir,
    respond(r) {
      process.env.FAKE_STDOUT = r.stdout ?? '';
      process.env.FAKE_STDERR = r.stderr ?? '';
      process.env.FAKE_EXIT = String(r.exit ?? 0);
      if (r.answer === undefined) delete process.env.FAKE_ANSWER; else process.env.FAKE_ANSWER = r.answer;
      if (r.sleep === undefined) delete process.env.FAKE_SLEEP; else process.env.FAKE_SLEEP = String(r.sleep);
    },
    async lastCall() {
      const names = (await readdir(logDir)).filter((f) => f.startsWith('arg.')).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
      const env: Record<string, string | null> = {};
      for (const v of WATCHED) env[v] = await read(`env.${v}`);
      return {
        args: await Promise.all(names.map(async (f) => (await read(f))!)),
        env,
        cwd: (await read('cwd'))!.trim(),
        filesAtStart: (await read('files'))!.split('\n').filter(Boolean),
        stdin: (await read('stdin')) ?? '',
        codexHome: { files: ((await read('codex-files')) ?? '').split('\n').filter(Boolean), authJson: await read('auth.json') },
      };
    },
    async restore() {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await rm(binDir, { recursive: true, force: true });
    },
  };
}
