import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import { executeClaude, type Spawner } from './runner';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): void {}
}

function makeSpawner(stdoutLines: string[], exitCode: number, stderrLines: string[] = []): {
  spawner: Spawner;
  capturedArgs: { cmd: string; args: string[] };
} {
  const captured = { cmd: '', args: [] as string[] };
  const spawner: Spawner = (cmd, args) => {
    captured.cmd = cmd;
    captured.args = args;
    const child = new FakeChild();
    setImmediate(() => {
      for (const l of stdoutLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      for (const l of stderrLines) child.stderr.emit('data', Buffer.from(l + '\n'));
      child.emit('close', exitCode);
    });
    return child as unknown as ReturnType<Spawner>;
  };
  return { spawner, capturedArgs: captured };
}

describe('executeClaude', () => {
  test('passes prompt + model + permission flags', async () => {
    const { spawner, capturedArgs } = makeSpawner([], 0);
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      env: { PATH: '/usr/bin' },
      cwd: '/tmp',
      spawner,
    });
    expect(capturedArgs.cmd).toBe('/fake/claude');
    expect(capturedArgs.args).toContain('--print');
    expect(capturedArgs.args).toContain('--output-format');
    expect(capturedArgs.args).toContain('stream-json');
    expect(capturedArgs.args).toContain('--verbose');
    expect(capturedArgs.args).toContain('--model');
    expect(capturedArgs.args).toContain('sonnet');
    expect(capturedArgs.args).toContain('--dangerously-skip-permissions');
    expect(capturedArgs.args[capturedArgs.args.length - 1]).toBe('hi');
  });

  test('adds --resume when resumeSessionId given', async () => {
    const { spawner, capturedArgs } = makeSpawner([], 0);
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
      resumeSessionId: 'sess-xyz',
    });
    const idx = capturedArgs.args.indexOf('--resume');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs.args[idx + 1]).toBe('sess-xyz');
  });

  test('captures session_id from system/init event', async () => {
    const { spawner } = makeSpawner(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
        JSON.stringify({ type: 'result', result: 'done' }),
      ],
      0,
    );
    const result = await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
    });
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe('sess-1');
  });

  test('accumulates assistant text across multiple events', async () => {
    const { spawner } = makeSpawner(
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'foo ' }] } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'bar' }] } }),
        JSON.stringify({ type: 'result', result: 'foo bar' }),
      ],
      0,
    );
    const result = await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
    });
    expect(result.assistantText).toBe('foo bar');
    expect(result.resultText).toBe('foo bar');
  });

  test('calls onStdout with each chunk for log tee', async () => {
    const { spawner } = makeSpawner(['hello', 'world'], 0);
    const chunks: string[] = [];
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
      onStdout: (c) => chunks.push(c),
    });
    expect(chunks.join('')).toContain('hello');
    expect(chunks.join('')).toContain('world');
  });

  test('non-zero exit code is propagated', async () => {
    const { spawner } = makeSpawner([], 7);
    const result = await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
    });
    expect(result.exitCode).toBe(7);
  });

  test('handles JSON line split across multiple data chunks', async () => {
    const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'split-sess' });
    const half = Math.floor(initLine.length / 2);
    const part1 = initLine.slice(0, half);
    const part2 = initLine.slice(half) + '\n';

    const child = new FakeChild();
    const spawner: Spawner = () => {
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(part1));
        child.stdout.emit('data', Buffer.from(part2));
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<Spawner>;
    };

    const result = await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
    });
    expect(result.sessionId).toBe('split-sess');
  });

  test('appends --append-system-prompt when given', async () => {
    const { spawner, capturedArgs } = makeSpawner([], 0);
    await executeClaude({
      claudePath: '/fake/claude',
      promptBody: 'hi',
      model: 'sonnet',
      permissionMode: 'default',
      env: {},
      cwd: '/tmp',
      spawner,
      appendSystemPrompt: 'You are helpful.',
    });
    const idx = capturedArgs.args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs.args[idx + 1]).toBe('You are helpful.');
  });
});
