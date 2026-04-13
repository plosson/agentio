import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Structural invariants for the committed docker/Dockerfile.teleport —
 * the buildable-from-source Dockerfile used by `agentio teleport --git-branch`.
 *
 * Unlike the inline Dockerfile (which siteio builds in an empty context
 * and therefore cannot COPY), this one IS given the repo as a build
 * context by siteio's git-mode, so COPY is legitimate. The tests
 * below pin down the multi-stage structure, the non-root runtime,
 * the config-import + server-start CMD shape, and a handful of security
 * posture invariants.
 */

const DOCKERFILE_PATH = join(
  import.meta.dir,
  '..',
  '..',
  'docker',
  'Dockerfile.teleport'
);

function loadDockerfile(): string {
  return readFileSync(DOCKERFILE_PATH, 'utf8');
}

describe('docker/Dockerfile.teleport — structural invariants', () => {
  test('exists and is non-empty', () => {
    const df = loadDockerfile();
    expect(df.length).toBeGreaterThan(200);
  });

  test('first content line documents it as the teleport Dockerfile', () => {
    const df = loadDockerfile();
    const firstComment = df
      .split('\n')
      .find((l) => l.trim().startsWith('#') && l.length > 1);
    expect(firstComment).toMatch(/teleport/i);
  });

  test('uses a multi-stage build (builder + runtime)', () => {
    const df = loadDockerfile();
    const fromLines = df
      .split('\n')
      .filter((l) => /^\s*FROM\s/.test(l));
    expect(fromLines.length).toBe(2);
  });

  test('stage 1 builds with oven/bun', () => {
    const df = loadDockerfile();
    expect(df).toMatch(/FROM\s+oven\/bun/);
    expect(df).toMatch(/AS\s+builder/);
  });

  test('stage 1 runs bun install with --frozen-lockfile', () => {
    const df = loadDockerfile();
    expect(df).toContain('bun install --frozen-lockfile');
  });

  test('stage 1 copies package.json + bun.lock separately from the rest', () => {
    const df = loadDockerfile();
    // This layer-caching discipline matters — we want bun install to
    // only re-run when deps change, not on every source edit.
    expect(df).toMatch(/COPY\s+package\.json\s+bun\.lock\*?\s+\.\//);
  });

  test('stage 1 compiles the native binary via build:native', () => {
    const df = loadDockerfile();
    expect(df).toContain('bun run build:native');
  });

  test('stage 2 is ubuntu:24.04', () => {
    const df = loadDockerfile();
    expect(df).toMatch(/FROM\s+ubuntu:24\.04\s*(?:\n|$)/);
  });

  test('stage 2 installs ca-certificates, curl, tini', () => {
    const df = loadDockerfile();
    expect(df).toContain('ca-certificates');
    expect(df).toContain('curl');
    expect(df).toContain('tini');
  });

  test('stage 2 cleans up apt lists', () => {
    const df = loadDockerfile();
    expect(df).toContain('rm -rf /var/lib/apt/lists/*');
  });

  test('stage 2 creates non-root agentio user with uid 1001', () => {
    const df = loadDockerfile();
    expect(df).toContain('groupadd -g 1001 agentio');
    expect(df).toContain('useradd -u 1001 -g agentio');
    expect(df).toContain('USER agentio');
  });

  test('copies binary from stage 1 with --chown=agentio:agentio', () => {
    const df = loadDockerfile();
    expect(df).toMatch(
      /COPY\s+--from=builder\s+--chown=agentio:agentio\s+\/build\/dist\/agentio\s+\/home\/agentio\/bin\/agentio/
    );
  });

  test('sets HOME, XDG_CONFIG_HOME, PATH', () => {
    const df = loadDockerfile();
    expect(df).toContain('ENV HOME=/data');
    expect(df).toContain('ENV XDG_CONFIG_HOME=/data');
    expect(df).toMatch(/ENV PATH="\/home\/agentio\/bin:\$\{PATH\}"/);
  });

  test('exposes port 9999', () => {
    const df = loadDockerfile();
    expect(df).toContain('EXPOSE 9999');
  });

  test('HEALTHCHECK probes /health on 9999 with curl -sf', () => {
    const df = loadDockerfile();
    expect(df).toContain('HEALTHCHECK');
    expect(df).toContain('curl -sf http://localhost:9999/health');
  });

  test('HEALTHCHECK has start-period ≥ 30s', () => {
    const df = loadDockerfile();
    expect(df).toMatch(/--start-period=(\d+)s/);
    const match = df.match(/--start-period=(\d+)s/);
    const seconds = Number(match![1]);
    expect(seconds).toBeGreaterThanOrEqual(30);
  });

  test('tini is PID 1 via ENTRYPOINT', () => {
    const df = loadDockerfile();
    expect(df).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
  });

  test('CMD runs config import THEN the server, via sh -c with exec', () => {
    const df = loadDockerfile();
    expect(df).toContain(
      'CMD ["sh", "-c", "agentio config import && exec agentio server start --foreground --host 0.0.0.0 --port 9999"]'
    );
  });

  test('CMD binds to 0.0.0.0 (required for Docker networking)', () => {
    const df = loadDockerfile();
    const cmdLine = df.match(/CMD \[.*\]/m)?.[0] ?? '';
    expect(cmdLine).toContain('--host 0.0.0.0');
  });
});

describe('docker/Dockerfile.teleport — security posture', () => {
  test('runtime stage switches to USER agentio before the CMD runs', () => {
    const df = loadDockerfile();
    // Find the position of USER agentio and the FINAL CMD/ENTRYPOINT.
    const userIdx = df.lastIndexOf('USER agentio');
    const cmdIdx = df.search(/^CMD /m);
    expect(userIdx).toBeGreaterThan(-1);
    expect(cmdIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(cmdIdx);
  });

  test('does not install sudo', () => {
    const df = loadDockerfile();
    expect(df).not.toContain('sudo');
  });

  test('does not EXPOSE SSH', () => {
    const df = loadDockerfile();
    expect(df).not.toContain('EXPOSE 22');
  });

  test('HEALTHCHECK runs under the agentio user (no root escalation)', () => {
    // Since USER agentio is set before HEALTHCHECK and CMD, they both
    // run as agentio. Verify by ordering: USER must come before the
    // HEALTHCHECK directive.
    const df = loadDockerfile();
    const userIdx = df.lastIndexOf('USER agentio');
    const hcIdx = df.indexOf('HEALTHCHECK');
    expect(userIdx).toBeLessThan(hcIdx);
  });
});
