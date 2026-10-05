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
