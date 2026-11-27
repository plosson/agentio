import { access, mkdtemp, readFile, rm } from 'fs/promises';
import { constants } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliError } from '../../utils/errors';
import { parseSessionToken, PICSI_URL } from './client';

const IMPORT_SESSION = 'Use agentio picsi profile add --token to paste an existing Picsi session instead';

/** Parse the provider's JSON string literal without evaluating its callback script. */
export function parsePicsiCallback(body: string): string {
  let response: { code?: unknown; data?: { token?: unknown } };
  try {
    const literal = body.match(/\bcallback\(\s*("(?:[^"\\]|\\.)*")\s*,/);
    response = JSON.parse(literal ? JSON.parse(literal[1]) : body);
  } catch {
    throw new CliError('AUTH_FAILED', 'Could not read the Picsi sign-in response', IMPORT_SESSION);
  }
  if (!response || response.code !== 0) throw new CliError('AUTH_FAILED', 'Picsi sign-in was refused or did not complete', 'Try signing in again');
  try { return parseSessionToken(response.data?.token); }
  catch { throw new CliError('AUTH_FAILED', 'Picsi did not return a valid session', IMPORT_SESSION); }
}

export async function findPicsiBrowser(): Promise<string | undefined> {
  const candidates = process.env.AGENTIO_CHROME ? [process.env.AGENTIO_CHROME] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'msedge'].map((name) => Bun.which(name)).filter((path): path is string => !!path),
    ...(process.platform === 'win32' ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter((path): path is string => !!path).flatMap((path) => [join(path, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(path, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]) : []),
  ];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch {}
  }
}

type BrowserEvent = { method: string; params: Record<string, any>; sessionId?: string };

class BrowserConnection {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>();
  onEvent: (event: BrowserEvent) => void = () => {};

  constructor(private readonly socket: WebSocket, signal: AbortSignal) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) { this.onEvent(message); return; }
      const request = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) request?.reject(new CliError('AUTH_FAILED', 'Could not receive the browser sign-in response', IMPORT_SESSION));
      else request?.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending(new CliError('AUTH_FAILED', 'The sign-in browser disconnected')));
    signal.addEventListener('abort', () => this.rejectPending(signal.reason), { once: true });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { this.pending.delete(id); reject(new CliError('AUTH_FAILED', 'The sign-in browser disconnected')); }
    });
  }

  private rejectPending(error: unknown): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  close(): void { this.socket.close(); }
}

interface SignInOptions {
  /** Real-browser tests use a local provider and a hidden, separate browser. */
  origin?: string;
  headless?: boolean;
  timeoutMs?: number;
  /** Tests close the actual browser window, rather than relying on script-initiated window.close(). */
  onReady?: (window: { close(): Promise<void> }) => void | Promise<void>;
}

/** Capture only Picsi's callback, before its script closes the window or logs the session. */
export async function capturePicsiSignIn(options: SignInOptions = {}): Promise<string> {
  const executable = await findPicsiBrowser();
  if (!executable) throw new CliError('CONFIG_ERROR', 'Picsi sign-in needs Chrome, Chromium or Edge', `${IMPORT_SESSION}, or set AGENTIO_CHROME to your browser executable`);
  const origin = options.origin ?? PICSI_URL;
  const folder = await mkdtemp(join(tmpdir(), 'agentio-picsi-signin-'));
  const controller = new AbortController();
  const { signal } = controller;
  let settled = false;
  let closing = false;
  let resolve!: (token: string) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  // A cancellation can arrive during browser startup, before the result is awaited.
  void result.catch(() => {});
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    reject(error);
    controller.abort(error);
  };
  const timer = setTimeout(() => fail(new CliError('AUTH_FAILED', 'Picsi sign-in timed out', IMPORT_SESSION)), options.timeoutMs ?? 180_000);
  let browser: ReturnType<typeof Bun.spawn> | undefined;
  let connection: BrowserConnection | undefined;
  try {
    browser = Bun.spawn([executable,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--disable-sync',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + folder, ...(options.headless ? ['--headless=new'] : []), 'about:blank',
    ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    void browser.exited.then(() => { if (!closing) fail(new CliError('AUTH_FAILED', 'The Picsi sign-in window was closed before sign-in completed', IMPORT_SESSION)); });
    let portInfo = '';
    while (!portInfo) {
      signal.throwIfAborted();
      try { portInfo = await readFile(join(folder, 'DevToolsActivePort'), 'utf8'); }
      catch { await Bun.sleep(50); }
    }
    const [port, path] = portInfo.trim().split('\n');
    if (!/^\d+$/.test(port) || !path?.startsWith('/devtools/browser/')) throw new CliError('AUTH_FAILED', 'Could not connect to the sign-in browser', IMPORT_SESSION);
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((yes, no) => {
      socket.addEventListener('open', () => yes(), { once: true });
      socket.addEventListener('error', () => no(new CliError('AUTH_FAILED', 'Could not connect to the sign-in browser', IMPORT_SESSION)), { once: true });
      signal.addEventListener('abort', () => { socket.close(); no(signal.reason); }, { once: true });
    });
    connection = new BrowserConnection(socket, signal);
    const protocol = connection;
    const sessions = new Map<string, Promise<string>>();
    let signInTarget: string | undefined;
    const handle = async ({ method, params, sessionId }: BrowserEvent): Promise<void> => {
      if (method === 'Target.attachedToTarget') {
        const attached = params.sessionId as string;
        if (params.targetInfo.type !== 'page') { await protocol.send('Runtime.runIfWaitingForDebugger', {}, attached); return; }
        const ready = (async () => {
          await protocol.send('Fetch.enable', { patterns: [{ urlPattern: origin + '/user/callback*', requestStage: 'Response' }] }, attached);
          await protocol.send('Runtime.runIfWaitingForDebugger', {}, attached);
          return attached;
        })();
        sessions.set(params.targetInfo.targetId, ready);
        await ready;
      } else if (method === 'Target.targetDestroyed' && params.targetId === signInTarget && !closing) {
        fail(new CliError('AUTH_FAILED', 'The Picsi sign-in window was closed before sign-in completed', IMPORT_SESSION));
      } else if (method === 'Fetch.requestPaused') {
        const url = new URL(params.request.url);
        if (url.origin !== origin || url.pathname !== '/user/callback') {
          await protocol.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
          return;
        }
        const response = await protocol.send('Fetch.getResponseBody', { requestId: params.requestId }, sessionId);
        const token = parsePicsiCallback(response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body);
        await protocol.send('Fetch.fulfillRequest', {
          requestId: params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }, { name: 'cache-control', value: 'no-store' }],
          body: Buffer.from('<!doctype html><title>Picsi connected</title><p>Sign-in received. Return to Agentio.</p>').toString('base64'),
        }, sessionId);
        if (!settled) { settled = true; resolve(token); }
      }
    };
    protocol.onEvent = (event) => { void handle(event).catch(fail); };
    await protocol.send('Target.setDiscoverTargets', { discover: true });
    await protocol.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const targets = await protocol.send('Target.getTargets');
    const targetId = targets.targetInfos.find((target: any) => target.type === 'page')?.targetId;
    if (!targetId) throw new CliError('AUTH_FAILED', 'Could not open the Picsi sign-in window', IMPORT_SESSION);
    signInTarget = targetId;
    while (!sessions.has(targetId)) { signal.throwIfAborted(); await Bun.sleep(10); }
    const sessionId = await sessions.get(targetId)!;
    await protocol.send('Page.navigate', { url: origin + '/user/login' }, sessionId);
    await options.onReady?.({ close: async () => { await protocol.send('Target.closeTarget', { targetId }); } });
    return await result;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('AUTH_FAILED', 'Could not complete browser sign-in with Picsi', IMPORT_SESSION);
  } finally {
    closing = true;
    clearTimeout(timer);
    if (connection) {
      await Promise.race([connection.send('Browser.close').catch(() => {}), Bun.sleep(1000)]);
      connection.close();
    }
    if (browser) {
      await Promise.race([browser.exited, Bun.sleep(1000)]);
      if (browser.exitCode === null) { browser.kill(); await browser.exited; }
    }
    if (!signal.aborted) controller.abort(new CliError('AUTH_FAILED', 'Sign-in finished'));
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
