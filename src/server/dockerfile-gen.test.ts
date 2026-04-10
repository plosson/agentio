import { describe, expect, test } from 'bun:test';

import { generateTeleportDockerfile } from './dockerfile-gen';

/**
 * Pure unit tests for the teleport Dockerfile generator. These don't
 * actually build a container; they just assert on the string that
 * gets fed to siteio. The goal is to catch refactors that silently
 * change container semantics — e.g. flipping the user to root, or
 * dropping tini, or breaking the healthcheck.
 */

describe('generateTeleportDockerfile — structural invariants', () => {
  test('is a non-empty string', () => {
    const df = generateTeleportDockerfile();
    expect(df).toBeTruthy();
    expect(df.length).toBeGreaterThan(200);
  });

  test('starts with a comment declaring it auto-generated', () => {
    const df = generateTeleportDockerfile();
    expect(df.split('\n')[0]).toMatch(/^#.*auto-generated.*agentio teleport/i);
  });

  test('uses ubuntu:24.04 as the base image', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('FROM ubuntu:24.04');
  });

  test('installs ca-certificates, curl, tini', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('ca-certificates');
    expect(df).toContain('curl');
    expect(df).toContain('tini');
  });

  test('cleans up apt lists (image size hygiene)', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('rm -rf /var/lib/apt/lists/*');
  });

  test('creates the non-root agentio user with uid 1001', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('groupadd -g 1001 agentio');
    expect(df).toContain('useradd -u 1001 -g agentio');
    expect(df).toContain('USER agentio');
  });

  test('sets HOME, XDG_CONFIG_HOME, PATH for the non-root user', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('ENV HOME=/data');
    expect(df).toContain('ENV XDG_CONFIG_HOME=/data');
    expect(df).toContain('ENV PATH="/home/agentio/bin:${PATH}"');
  });

  test('ensures /data and /home/agentio/bin are owned by agentio', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('chown -R agentio:agentio /data /home/agentio/bin');
  });

  test('never uses COPY or ADD (siteio inline Dockerfile constraint)', () => {
    const df = generateTeleportDockerfile();
    const lines = df.split('\n').filter((l) => !l.trim().startsWith('#'));
    for (const line of lines) {
      expect(line).not.toMatch(/^\s*COPY\b/);
      expect(line).not.toMatch(/^\s*ADD\b/);
    }
  });
});

describe('generateTeleportDockerfile — binary fetch', () => {
  test('fetches the binary at BUILD time via RUN curl (not at CMD)', () => {
    const df = generateTeleportDockerfile();
    // The curl call for the binary should be in a RUN, not in the CMD.
    const cmdLine = df.match(/CMD \[.*\]/)?.[0] ?? '';
    expect(cmdLine).not.toContain('curl -fL');
    expect(df).toContain('curl -fL');
  });

  test('resolves arch for both x86_64 and arm64 linux', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('aarch64|arm64');
    expect(df).toContain('x86_64|amd64');
    expect(df).toContain('linux-arm64');
    expect(df).toContain('linux-x64');
  });

  test('unsupported arch exits 1 with a clear message', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('unsupported arch');
    expect(df).toContain('exit 1');
  });

  test('no version pinned → queries GitHub releases/latest for the tag', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain(
      'https://api.github.com/repos/plosson/agentio/releases/latest'
    );
    expect(df).toContain('tag_name');
  });

  test('--version pinned → emits a literal VERSION="X" assignment', () => {
    const df = generateTeleportDockerfile({ version: '1.2.3' });
    expect(df).toContain('VERSION="1.2.3"');
    expect(df).not.toContain('releases/latest');
  });

  test('download URL references both VERSION and PLATFORM variables', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain(
      'https://github.com/plosson/agentio/releases/download/v${VERSION}/agentio-${PLATFORM}'
    );
  });

  test('chmod +x on the installed binary', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('chmod +x /home/agentio/bin/agentio');
  });
});

describe('generateTeleportDockerfile — port + healthcheck + entrypoint', () => {
  test('default port is 9999', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('EXPOSE 9999');
    expect(df).toContain('http://localhost:9999/health');
    expect(df).toContain('--port 9999');
  });

  test('custom port threads through EXPOSE + HEALTHCHECK + CMD', () => {
    const df = generateTeleportDockerfile({ port: 8080 });
    expect(df).toContain('EXPOSE 8080');
    expect(df).toContain('http://localhost:8080/health');
    expect(df).toContain('--port 8080');
    expect(df).not.toContain('EXPOSE 9999');
  });

  test('HEALTHCHECK has 30s start-period (enough for config import)', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('--start-period=30s');
    expect(df).toContain('HEALTHCHECK');
  });

  test('HEALTHCHECK uses curl -sf to exit non-zero on failure', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('curl -sf http://localhost');
    expect(df).toContain('exit 1');
  });

  test('tini is PID 1 via ENTRYPOINT', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
  });

  test('CMD runs config import THEN the server, via sh -c', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain(
      'CMD ["sh", "-c", "agentio config import && exec agentio server start --foreground --host 0.0.0.0 --port 9999"]'
    );
  });

  test('CMD uses `exec` before starting the server (so tini sees the right PID)', () => {
    const df = generateTeleportDockerfile();
    const cmdLine = df.match(/CMD \[.*\]/)?.[0] ?? '';
    expect(cmdLine).toContain('exec agentio server start');
  });

  test('CMD binds to 0.0.0.0 (required for Docker networking)', () => {
    const df = generateTeleportDockerfile();
    expect(df).toContain('--host 0.0.0.0');
  });
});

describe('generateTeleportDockerfile — security posture', () => {
  test('switches to non-root user BEFORE the CMD runs', () => {
    const df = generateTeleportDockerfile();
    const userIdx = df.indexOf('USER agentio');
    const cmdIdx = df.search(/^CMD /m);
    expect(userIdx).toBeGreaterThan(-1);
    expect(cmdIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeLessThan(cmdIdx);
  });

  test('does not install sudo', () => {
    const df = generateTeleportDockerfile();
    expect(df).not.toContain('sudo');
  });

  test('does not expose an SSH port', () => {
    const df = generateTeleportDockerfile();
    expect(df).not.toContain('EXPOSE 22');
  });
});
