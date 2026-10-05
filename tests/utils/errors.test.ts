import { expect, test } from 'bun:test';

/** Run handleError in JSON mode in its own process: it prints and exits. */
async function jsonError(throwing: string): Promise<{ stdout: string; exit: number }> {
  const script = `
    import { Command } from 'commander';
    import { addJsonOption, enterJsonMode } from './src/utils/output';
    import { handleError, CliError } from './src/utils/errors';
    const cmd = addJsonOption(new Command('x'));
    cmd.parse(['--json'], { from: 'user' });
    enterJsonMode(cmd);
    handleError(${throwing});
  `;
  const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const exit = await proc.exited;
  return { stdout: await new Response(proc.stdout).text(), exit };
}

test('handleError in JSON mode gives a plain Error a code', async () => {
  const { stdout, exit } = await jsonError(`new Error('boom')`);
  expect(JSON.parse(stdout)).toMatchObject({ event: 'error', code: 'UNKNOWN_ERROR', message: 'boom' });
  expect(exit).toBe(1);
}, 30_000);

test('handleError in JSON mode gives a thrown non-Error a code too', async () => {
  const { stdout, exit } = await jsonError(`'just a string'`);
  expect(JSON.parse(stdout)).toMatchObject({ event: 'error', code: 'UNKNOWN_ERROR' });
  expect(exit).toBe(1);
}, 30_000);

test('handleError in JSON mode keeps a CliError code and its exit code', async () => {
  const { stdout, exit } = await jsonError(`new CliError('CONFIG_ERROR', 'bad', 'fix it')`);
  expect(JSON.parse(stdout)).toMatchObject({ event: 'error', code: 'CONFIG_ERROR', message: 'bad', suggestion: 'fix it' });
  expect(exit).toBe(3);
}, 30_000);
