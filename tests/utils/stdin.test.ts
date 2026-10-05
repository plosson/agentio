import { describe, expect, test } from 'bun:test';

const script = Bun.which('script');
const SRC = new URL('../../src/utils/stdin.ts', import.meta.url).pathname;

/**
 * Run promptHidden in a pseudo-terminal (via `script`), type `typed` after the
 * prompt is up, and report how it ended. `script` needs a real stdin, so a
 * shell feeds it.
 */
async function runPrompt(typed: string): Promise<{ exited: boolean; code: number | null; out: string }> {
  const program = `import { promptHidden } from ${JSON.stringify(SRC)}; const v = await promptHidden('ASK> '); console.log('GOT[' + v + ']');`;
  const proc = Bun.spawn(
    ['sh', '-c', `(sleep 1; printf "$TYPED") | "$SCRIPT" -q /dev/null "$BUN" -e "$PROGRAM"`],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TYPED: typed, SCRIPT: script!, BUN: process.execPath, PROGRAM: program } },
  );
  let out = '';
  const reader = (async () => {
    for await (const chunk of proc.stdout) out += Buffer.from(chunk).toString();
  })();
  const code = await Promise.race([proc.exited, Bun.sleep(4000).then(() => null)]);
  const exited = code !== null;
  if (!exited) proc.kill('SIGKILL');
  await Promise.race([reader, Bun.sleep(200)]);
  return { exited, code, out };
}

describe.skipIf(!script)('promptHidden in a terminal', () => {
  test('Ctrl-D with nothing typed cancels instead of hanging', async () => {
    const result = await runPrompt('\\004');
    expect(result.exited).toBe(true);
    expect(result.out).toContain('GOT[]');
  });

  test('Ctrl-C exits with 130 instead of hanging', async () => {
    const result = await runPrompt('\\003');
    expect(result.exited).toBe(true);
    expect(result.code).toBe(130);
    expect(result.out).not.toContain('GOT[');
  });

  test('a typed answer resolves once and is not echoed', async () => {
    const result = await runPrompt('hunter2\\r');
    expect(result.exited).toBe(true);
    expect(result.out).toContain('GOT[hunter2]');
    expect(result.out.replace('GOT[hunter2]', '')).not.toContain('hunter2');
  });
});
