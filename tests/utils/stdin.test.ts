import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const root = resolve(import.meta.dir, '../..');

// Setup prompts run against the real process.stdin, so each case runs in a
// child process and feeds it through a pipe.
const child = `
import { createSetupContext } from '${root}/src/plugins/host-context';
const ctx = createSetupContext();
const answers = [];
for (const q of ['? Forum URL:', '? API Key:', '? Username:']) answers.push(await ctx.prompt(q));
answers.push(String(await ctx.confirm('Save?')));
answers.push(await ctx.prompt('? Token:', { secret: true }));
answers.push(await ctx.prompt('? More:'));
console.log(JSON.stringify(answers));
`;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentio-stdin-test-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function answer(parts: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', '-e', child], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: home },
  });
  for (const part of parts) {
    proc.stdin.write(part);
    await proc.stdin.flush();
    await Bun.sleep(50);
  }
  await proc.stdin.end();
  const exitCode = await proc.exited;
  return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

describe('setup prompts share one stdin reader', () => {
  // `printf 'host\nKEY\nuser\n' | agentio discourse profile add`: every answer
  // must reach its question, and running out of answers must not end silently.
  for (const [name, parts] of Object.entries({
    'one write': ['host\nKEY\nuser\ny\nsecret\n'],
    'delayed writes': ['ho', 'st\nKEY\n', 'user\r\n', 'y\nsec', 'ret\n'],
  })) {
    test(name, async () => {
      const { exitCode, stdout, stderr } = await answer(parts);
      expect({ exitCode, stdout: stdout.trim(), stderr: exitCode ? stderr : '' }).toEqual({
        exitCode: 0,
        stdout: JSON.stringify(['host', 'KEY', 'user', 'true', 'secret', '']),
        stderr: '',
      });
    }, 15000);
  }
});

// When the browser callback wins, the pasted-redirect prompt must let go of
// stdin: the answer to the next question (Jira "Select a site") is not its.
const oauthChild = `
import { createSetupContext } from '${root}/src/plugins/host-context';
const ctx = createSetupContext();
const result = await ctx.oauth({
  serviceName: 'Demo',
  expectedState: 's1',
  authorizationUrl: (redirect) => {
    setTimeout(() => fetch(redirect + '?code=abc&state=s1'), 100);
    return 'https://example.invalid/auth';
  },
});
console.log('won ' + result.code);
const site = await ctx.prompt('? Select a site (1-2):');
const ok = await ctx.confirm('Continue?');
console.log(JSON.stringify([site, ok]));
`;

describe('OAuth callback leaves stdin to the next prompt', () => {
  for (const [name, parts] of Object.entries({
    'one write': ['2\nyes\n'],
    'delayed writes': ['2', '\n', 'ye', 's\n'],
  })) {
    test(name, async () => {
      const proc = Bun.spawn([process.execPath, '-e', oauthChild], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        // No browser opener on PATH; the callback is fetched by the child itself.
        env: { ...process.env, HOME: home, PATH: home, NO_PROXY: '127.0.0.1,localhost' },
      });
      const reader = proc.stdout.getReader();
      let stdout = '';
      while (!stdout.includes('won abc')) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += new TextDecoder().decode(value);
      }
      for (const part of parts) {
        proc.stdin.write(part);
        await proc.stdin.flush();
        await Bun.sleep(50);
      }
      const timer = setTimeout(() => proc.kill(), 5000);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += new TextDecoder().decode(value);
      }
      await proc.stdin.end();
      expect({ exitCode, stdout: stdout.trim() }).toEqual({
        exitCode: 0,
        stdout: `won abc\n${JSON.stringify(['2', true])}`,
      });
    }, 15000);
  }
});
