import type { Subprocess } from 'bun';

/**
 * Shared test helpers for subprocess-based integration tests. Not a test
 * file itself — imported by `*.test.ts` files that spawn the agentio
 * daemon.
 *
 * The main job of this module is to work around a port-allocation race
 * in `findFreePort` + `Bun.spawn`:
 *
 *   1. We ask the OS for a free port via `Bun.serve({ port: 0 })`.
 *   2. We stop the probe, freeing the port.
 *   3. We spawn `agentio server start --port <that port>`.
 *
 * Between steps 2 and 3 another process (another parallel test, or
 * anything on the host) can grab the port, and the subprocess then
 * fails with `Failed to start server. Is port N in use?`.
 *
 * `startServerSubprocess` wraps the whole cycle in a retry loop that
 * catches the "port in use" failure and re-rolls a fresh port, up to
 * a few attempts.
 */

export interface StartSubprocessOptions {
  home: string;
  extraArgs?: string[];
  extraEnv?: Record<string, string>;
  /** Max retries on port allocation failure. Default 4. */
  maxRetries?: number;
}

export interface StartedSubprocess {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  port: number;
  apiKey: string;
  startupLog: string;
}

export async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== 'number') {
    throw new Error('Bun.serve did not return a numeric port');
  }
  return port;
}

export async function startServerSubprocess(
  opts: StartSubprocessOptions
): Promise<StartedSubprocess> {
  const maxRetries = opts.maxRetries ?? 4;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const port = await findFreePort();

    const env: Record<string, string> = {
      ...process.env,
      HOME: opts.home,
      AGENTIO_SERVER_PORT: '',
      AGENTIO_SERVER_HOST: '',
      AGENTIO_SERVER_API_KEY: '',
      ...(opts.extraEnv ?? {}),
    };
    for (const k of [
      'AGENTIO_SERVER_PORT',
      'AGENTIO_SERVER_HOST',
      'AGENTIO_SERVER_API_KEY',
    ]) {
      if (!opts.extraEnv?.[k]) delete env[k];
    }

    const proc = Bun.spawn(
      [
        'bun',
        'run',
        'src/index.ts',
        'server',
        'start',
        '--foreground',
        '--port',
        String(port),
        ...(opts.extraArgs ?? []),
      ],
      { stdout: 'pipe', stderr: 'pipe', env }
    );

    // Race stdout reads against proc.exited + a hard timeout so we can
    // cleanly distinguish "starting up" from "already died".
    const decoder = new TextDecoder();
    let buffer = '';
    const reader = proc.stdout.getReader();
    const deadline = Date.now() + 10_000;
    let ready = false;
    let died = false;

    try {
      while (!ready) {
        if (Date.now() > deadline) {
          proc.kill('SIGKILL');
          throw new Error(`startup timeout at attempt ${attempt + 1}:\n${buffer}`);
        }
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(
              () => resolve({ done: true, value: undefined }),
              Math.max(100, deadline - Date.now())
            )
          ),
        ]);
        if (done) {
          died = true;
          break;
        }
        buffer += decoder.decode(value);
        if (buffer.includes('Server ready')) {
          ready = true;
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!ready) {
      const stderr = await new Response(proc.stderr).text().catch(() => '');
      const combined = `${buffer}\n${stderr}`;
      // If this was a port collision, retry with a fresh port.
      if (
        died &&
        (combined.includes('Is port') ||
          combined.includes('EADDRINUSE') ||
          combined.includes('address already in use'))
      ) {
        lastError = new Error(
          `port ${port} collided on attempt ${attempt + 1}: ${combined.trim()}`
        );
        // Make sure the process is gone before looping.
        try {
          proc.kill('SIGKILL');
          await proc.exited;
        } catch {
          /* ignore */
        }
        continue;
      }
      // Any other startup failure: throw immediately.
      try {
        proc.kill('SIGKILL');
        await proc.exited;
      } catch {
        /* ignore */
      }
      throw new Error(
        `server failed to start (attempt ${attempt + 1}):\n${combined}`
      );
    }

    const apiKey = buffer.match(/API Key: (\S+)/)?.[1] ?? '';
    if (!apiKey) {
      proc.kill('SIGKILL');
      await proc.exited;
      throw new Error(
        `could not parse API key from startup log:\n${buffer}`
      );
    }

    return {
      proc: proc as Subprocess<'ignore', 'pipe', 'pipe'>,
      port,
      apiKey,
      startupLog: buffer,
    };
  }

  throw new Error(
    `startServerSubprocess: exhausted ${maxRetries} retries. Last error: ${lastError?.message ?? 'unknown'}`
  );
}

export async function shutdown(
  proc: Subprocess<'ignore', 'pipe', 'pipe'>,
  signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM',
  timeoutMs = 5000
): Promise<number> {
  proc.kill(signal);
  const result = await Promise.race([
    proc.exited.then((code) => ({ ok: true as const, code })),
    new Promise<{ ok: false }>((resolve) =>
      setTimeout(() => resolve({ ok: false as const }), timeoutMs)
    ),
  ]);
  if (!result.ok) {
    proc.kill('SIGKILL');
    await proc.exited;
    throw new Error(`process did not exit on ${signal} within ${timeoutMs}ms`);
  }
  return result.code;
}
