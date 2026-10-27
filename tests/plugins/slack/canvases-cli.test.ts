import { beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { exitCodeForError } from '../../../src/utils/errors';
import type { SlackCredentials } from '../../../src/plugins/slack/types';
import { TOKEN } from './fake-slack';

let vault: ReturnType<typeof withTempVault>;

function withProfiles(profiles: () => Record<string, { readOnly?: boolean; credentials: SlackCredentials }>): void {
  const own = withTempVault('agentio-slack-canvases-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { slack: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: { slack: Object.fromEntries(entries.map(([name, p]) => [name, p.credentials])) } as never,
    };
  });
  beforeEach(() => { vault = own; });
}

async function cli(args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...vault.env(), NO_COLOR: '1', HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' },
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

const token: SlackCredentials = { type: 'token', token: TOKEN };
const INVALID = exitCodeForError('INVALID_PARAMS');
const DENIED = exitCodeForError('PERMISSION_DENIED');
/** Proof that a case stopped before Slack: no request was even attempted. */
const noRequest = (r: { stderr: string }) => {
  expect(r.stderr).not.toContain('NETWORK_ERROR');
  expect(r.stderr).not.toContain('unknown command');
};

describe('set', () => {
  withProfiles(() => ({ main: { credentials: token } }));

  test('empty, blank or missing Markdown is refused without --force, before any request', async () => {
    for (const input of ['', '   \n\t\n']) {
      const res = await cli(['slack', 'canvases', 'set', 'F0CANVAS01'], input);
      expect(res.code).toBe(INVALID);
      expect(res.stderr).toContain('--force');
      noRequest(res);
    }
  });

  test('a file that does not exist is refused before any request', async () => {
    const res = await cli(['slack', 'canvases', 'set', 'F0CANVAS01', '/nonexistent/plan.md']);
    expect(res.code).toBe(INVALID);
    noRequest(res);
  });
});

describe('create', () => {
  withProfiles(() => ({ main: { credentials: token } }));

  test('a standalone canvas needs a title; --channel takes no title', async () => {
    const untitled = await cli(['slack', 'canvases', 'create'], '# x');
    expect(untitled.code).toBe(INVALID);
    expect(untitled.stderr).toContain('title is required');
    const channelWithTitle = await cli(['slack', 'canvases', 'create', '--channel', '#eng', 'Title', 'file.md'], '# x');
    expect(channelWithTitle.code).toBe(INVALID);
    expect(channelWithTitle.stderr).toContain('takes no title');
  });

  test('rename to a blank title is refused', async () => {
    const res = await cli(['slack', 'canvases', 'rename', 'F0CANVAS01', '  ']);
    expect(res.code).toBe(INVALID);
    noRequest(res);
  });
});

describe('a read-only profile', () => {
  withProfiles(() => ({ ro: { readOnly: true, credentials: token } }));

  test('create, set and rename are refused before any request', async () => {
    for (const args of [
      ['create', 'Title'],
      ['set', 'F0CANVAS01'],
      ['rename', 'F0CANVAS01', 'New'],
    ]) {
      const res = await cli(['slack', 'canvases', ...args], '# content');
      expect(res.code).toBe(DENIED);
      expect(res.stderr).toContain('read-only');
      noRequest(res);
    }
  });
});

describe('a webhook profile', () => {
  withProfiles(() => ({ hook: { credentials: { type: 'webhook', webhookUrl: 'https://hooks.slack.com/services/T/B/X' } } }));

  test('canvases commands are refused before any request', async () => {
    const res = await cli(['slack', 'canvases', 'get', 'F0CANVAS01']);
    expect(res.code).toBe(INVALID);
    noRequest(res);
  });
});
