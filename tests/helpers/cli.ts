/**
 * The CLI in its own process, as a program runs it: `lines` on stdin, then stdin closed. It is killed
 * after `timeoutMs`, so a hang fails the test instead of stalling the suite. `events` are stdout's JSON lines.
 */
export async function runCli(args: string[], env: Record<string, string>, lines: string[] = [], timeoutMs = 30_000) {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: new Blob([lines.map((line) => `${line}\n`).join('')]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...env, NO_COLOR: '1' },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, events: stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line)) };
}

/**
 * The CLI in its own process with stdin left open, as a terminal leaves it: a browser sign-in waits at
 * its pasted-address question until the callback ends it. `printed` resolves with the first match of
 * `pattern` on stderr; `finish` with the exit code and the whole stderr. Killed after `timeoutMs`.
 */
export function spawnCli(args: string[], env: Record<string, string>, timeoutMs = 25_000) {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...env, NO_COLOR: '1' } });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let stderr = '';
  return {
    async printed(pattern: RegExp): Promise<RegExpMatchArray> {
      for (let match = stderr.match(pattern); !match; match = stderr.match(pattern)) {
        const r = await reader.read();
        if (r.done) throw new Error(`never printed ${pattern}; stderr:\n${stderr}`);
        stderr += decoder.decode(r.value);
      }
      return stderr.match(pattern)!;
    },
    async finish(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      const exitCode = await proc.exited;
      clearTimeout(timer);
      proc.stdin.end();
      for (let r = await reader.read(); !r.done; r = await reader.read()) stderr += decoder.decode(r.value);
      return { exitCode, stdout: await new Response(proc.stdout).text(), stderr };
    },
  };
}
