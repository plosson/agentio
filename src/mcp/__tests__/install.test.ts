import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync } from 'fs';

// Re-implement the core install logic here for unit testing
// (the actual command uses process.cwd() and commander, so we test the JSON generation)

interface ServiceProfilePair {
  service: string;
  profile?: string;
}

async function loadMcpJson(dir: string): Promise<Record<string, unknown>> {
  const filePath = join(dir, '.mcp.json');
  if (!existsSync(filePath)) {
    return {};
  }
  const content = await readFile(filePath, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

async function writeMcpJson(
  dir: string,
  pairs: ServiceProfilePair[]
): Promise<string> {
  const filePath = join(dir, '.mcp.json');
  const existing = await loadMcpJson(dir);
  const mcpServers = (existing.mcpServers as Record<string, unknown>) || {};

  const serveArgs = pairs.map((p) =>
    p.profile ? `${p.service}:${p.profile}` : p.service
  );

  mcpServers['agentio'] = {
    command: 'agentio',
    args: ['mcp', 'serve', ...serveArgs],
  };

  existing.mcpServers = mcpServers;
  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n');
  return filePath;
}

describe('MCP install (.mcp.json generation)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agentio-mcp-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('creates .mcp.json with correct structure', async () => {
    await writeMcpJson(tmpDir, [
      { service: 'gmail', profile: 'work' },
      { service: 'rss' },
    ]);

    const content = JSON.parse(
      await readFile(join(tmpDir, '.mcp.json'), 'utf-8')
    );

    expect(content).toEqual({
      mcpServers: {
        agentio: {
          command: 'agentio',
          args: ['mcp', 'serve', 'gmail:work', 'rss'],
        },
      },
    });
  });

  test('preserves other servers in existing .mcp.json', async () => {
    // Write an existing .mcp.json with another server
    await writeFile(
      join(tmpDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'other-server': {
            command: 'other',
            args: ['serve'],
          },
        },
      })
    );

    await writeMcpJson(tmpDir, [{ service: 'gmail', profile: 'work' }]);

    const content = JSON.parse(
      await readFile(join(tmpDir, '.mcp.json'), 'utf-8')
    );

    // Both servers should be present
    expect(content.mcpServers['other-server']).toEqual({
      command: 'other',
      args: ['serve'],
    });
    expect(content.mcpServers['agentio']).toEqual({
      command: 'agentio',
      args: ['mcp', 'serve', 'gmail:work'],
    });
  });

  test('updates existing agentio entry in .mcp.json', async () => {
    // First install
    await writeMcpJson(tmpDir, [{ service: 'gmail', profile: 'work' }]);

    // Second install with different services
    await writeMcpJson(tmpDir, [
      { service: 'slack', profile: 'team' },
      { service: 'rss' },
    ]);

    const content = JSON.parse(
      await readFile(join(tmpDir, '.mcp.json'), 'utf-8')
    );

    // Should be updated, not duplicated
    expect(content.mcpServers['agentio']).toEqual({
      command: 'agentio',
      args: ['mcp', 'serve', 'slack:team', 'rss'],
    });
  });

  test('creates .mcp.json when it does not exist', async () => {
    expect(existsSync(join(tmpDir, '.mcp.json'))).toBe(false);

    await writeMcpJson(tmpDir, [{ service: 'rss' }]);

    expect(existsSync(join(tmpDir, '.mcp.json'))).toBe(true);
  });
});
