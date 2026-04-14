import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';

import { executeCommand } from './server';
import type { McpToolDefinition } from './tools';

/**
 * Concurrency regression test for `executeCommand`.
 *
 * Before the AsyncLocalStorage refactor, `executeCommand` swapped
 * `console.log` / `process.stdout.write` per call and restored them in a
 * `finally` block. Under two overlapping invocations (as will happen under
 * the HTTP MCP server), the second call's swap would clobber the first
 * call's capture closure, so the first call's output would leak into the
 * second call's chunks (or vanish entirely). This test runs two calls in
 * parallel with `await` points between each log so the event loop is
 * guaranteed to interleave them, and asserts that each call only sees its
 * own output.
 */

function makeProgram(): Command {
  const program = new Command();
  program.name('agentio').exitOverride();

  program.command('slow-a').action(async () => {
    console.log('A:start');
    await new Promise((r) => setImmediate(r));
    process.stdout.write('A:middle\n');
    await new Promise((r) => setImmediate(r));
    console.log('A:end');
  });

  program.command('slow-b').action(async () => {
    console.log('B:start');
    await new Promise((r) => setImmediate(r));
    process.stdout.write('B:middle\n');
    await new Promise((r) => setImmediate(r));
    console.log('B:end');
  });

  return program;
}

function toolDef(name: string): McpToolDefinition {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {} },
    commandPath: [name],
    args: [],
    options: [],
  };
}

describe('executeCommand', () => {
  test('concurrent calls do not cross-contaminate stdout capture', async () => {
    const programA = makeProgram();
    const programB = makeProgram();

    const [a, b] = await Promise.all([
      executeCommand(programA, toolDef('slow-a'), {}),
      executeCommand(programB, toolDef('slow-b'), {}),
    ]);

    expect(a).toContain('A:start');
    expect(a).toContain('A:middle');
    expect(a).toContain('A:end');
    expect(a).not.toContain('B:');

    expect(b).toContain('B:start');
    expect(b).toContain('B:middle');
    expect(b).toContain('B:end');
    expect(b).not.toContain('A:');
  });

  test('sequential calls still capture correctly', async () => {
    const program = makeProgram();
    const first = await executeCommand(program, toolDef('slow-a'), {});
    const second = await executeCommand(makeProgram(), toolDef('slow-b'), {});

    expect(first).toContain('A:start');
    expect(first).toContain('A:end');
    expect(first).not.toContain('B:');

    expect(second).toContain('B:start');
    expect(second).toContain('B:end');
    expect(second).not.toContain('A:');
  });
});
