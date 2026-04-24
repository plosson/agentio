# Schedule / Daemon Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the per-schedule launchd mechanism into a single long-lived `agentio daemon` process that watches folders for `.run.md` files and fires them on time, and add a macOS install path for that daemon.

**Architecture:** Rename `gateway` → `daemon` across code, config, and install artifacts (with one-version back-compat). Add a `Scheduler` module inside the daemon that polls `config.daemon.scheduler.watchedFolders` every 60 seconds, parses frontmatter, and invokes the existing `runSchedule()` with `cwd = folder`. Retire the per-schedule launchd plists; provide `schedule migrate` to clean up legacy installs. Add a macOS LaunchAgent (`~/Library/LaunchAgents/me.agentio.daemon.plist`) for the daemon itself.

**Tech Stack:** Bun, TypeScript, Commander.js, SQLite (via Bun's `bun:sqlite`), `plist` (npm), `bun:test`, macOS `launchctl`, Linux `systemctl`.

**Companion spec:** `docs/superpowers/specs/2026-04-24-schedule-daemon-unification-design.md`

---

## File Structure

### New files
- `src/daemon/scheduler.ts` — scheduler lifecycle (start/stop/reload), tick loop, concurrency tracker
- `src/daemon/scheduler-core.ts` — pure functions: `scanWatchedFolders`, `dueJobs`, `computeCatchUp`
- `src/daemon/daemon-plist.ts` — pure function `buildDaemonPlist(...)` for the macOS LaunchAgent
- `src/daemon/scheduler.test.ts` — integration tests for the tick loop (injected FS + clock + spawner)
- `src/daemon/scheduler-core.test.ts` — pure-function tests
- `src/daemon/daemon-plist.test.ts` — plist snapshot test

### Renamed files (git mv)
- `src/gateway/` → `src/daemon/` (all files, including `daemon.ts`, `api.ts`, `client.ts`, `store.ts`, `webhook.ts`, `types.ts`, `adapters/*`)
- `src/commands/gateway.ts` → `src/commands/daemon.ts`

### Deleted files
- `src/services/schedule/launchd.ts`
- `src/services/schedule/launchd.test.ts`
- `src/services/schedule/plist-builder.ts`
- `src/services/schedule/plist-builder.test.ts`
- `src/services/schedule/folder-hash.ts`
- `src/services/schedule/folder-hash.test.ts`

### Modified files
- `src/types/config.ts` — add `DaemonConfig` (alias of `GatewayConfig` plus `scheduler` field), add `daemon?` on `Config`, keep `gateway?` readable for back-compat
- `src/config/config-manager.ts` — migrate `config.gateway` → `config.daemon` at load time
- `src/commands/schedule.ts` — add `watch` / `unwatch` / `watched` / `migrate` subcommands; remove plist side-effects from `add`/`sync`/`remove`; delegate `list`/`run` to the daemon when it's up
- `src/index.ts` — register `daemon` commands; keep `gateway` alias with deprecation warning
- `src/daemon/api.ts` (renamed from `src/gateway/api.ts`) — add `/scheduler/reload`, `/scheduler/list`, `/scheduler/run` routes
- `src/daemon/daemon.ts` (renamed from `src/gateway/daemon.ts`) — rename log/db files, start the scheduler
- `src/daemon/store.ts` (renamed from `src/gateway/store.ts`) — change default DB path to `daemon.db` with back-compat rename of `gateway.db`
- `CLAUDE.md` — update command reference
- `CHANGELOG.md` (or release notes) — entry for breaking rename

---

## Task 1: Add DaemonConfig type with scheduler field (back-compat with GatewayConfig)

**Files:**
- Modify: `src/types/config.ts`

- [ ] **Step 1: Write the failing test**

Create `src/types/config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { Config, DaemonConfig } from './config';

describe('DaemonConfig', () => {
  test('has all gateway fields plus scheduler', () => {
    const cfg: DaemonConfig = {
      apiKey: 'k',
      server: { port: 7890 },
      scheduler: {
        watchedFolders: [{ path: '/tmp/x', addedAt: 1 }],
        tickIntervalSec: 60,
      },
    };
    expect(cfg.scheduler?.watchedFolders[0].path).toBe('/tmp/x');
  });

  test('Config accepts both daemon and gateway (back-compat)', () => {
    const cfg: Config = {
      profiles: {},
      daemon: { apiKey: 'a' },
      gateway: { apiKey: 'b' },
    };
    expect(cfg.daemon?.apiKey).toBe('a');
    expect(cfg.gateway?.apiKey).toBe('b');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/types/config.test.ts`
Expected: FAIL with "DaemonConfig is not exported" (or similar type error).

- [ ] **Step 3: Add the types**

Edit `src/types/config.ts`. After the existing `GatewayConfig` interface, add:

```ts
export interface WatchedFolder {
  path: string;      // absolute path
  host?: string;     // optional hostname pin; skip if current host mismatches
  addedAt: number;   // unix ms
}

export interface SchedulerConfig {
  watchedFolders?: WatchedFolder[];
  tickIntervalSec?: number;  // default 60
}

export interface DaemonConfig extends GatewayConfig {
  scheduler?: SchedulerConfig;
}
```

Then change `Config` to add the `daemon?` field (keeping `gateway?`):

```ts
export interface Config {
  profiles: { /* unchanged */ };
  env?: Record<string, string>;
  daemon?: DaemonConfig;
  gateway?: GatewayConfig;  // legacy; read-only, migrated to daemon on load
  server?: ServerConfig;
  teleport?: TeleportConfig;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/types/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/config.ts src/types/config.test.ts
git commit -m "feat(daemon): add DaemonConfig type with scheduler field"
```

---

## Task 2: Migrate config.gateway → config.daemon at load time

**Files:**
- Modify: `src/config/config-manager.ts`
- Test: `src/config/config-manager.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `src/config/config-manager.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { migrateGatewayToDaemon } from './config-manager';

describe('migrateGatewayToDaemon', () => {
  test('copies gateway into daemon when daemon absent', () => {
    const input = { profiles: {}, gateway: { apiKey: 'k' } };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon).toEqual({ apiKey: 'k' });
    expect(out.gateway).toBeUndefined();
  });

  test('leaves daemon alone when already present', () => {
    const input = {
      profiles: {},
      gateway: { apiKey: 'old' },
      daemon: { apiKey: 'new' },
    };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon?.apiKey).toBe('new');
    expect(out.gateway).toBeUndefined();
  });

  test('is a no-op when neither is present', () => {
    const input = { profiles: {} };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon).toBeUndefined();
    expect(out.gateway).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/config/config-manager.test.ts`
Expected: FAIL — `migrateGatewayToDaemon` is not exported.

- [ ] **Step 3: Implement and wire into loadConfig**

Edit `src/config/config-manager.ts`. Add this function above `loadConfig`:

```ts
/**
 * Migrate legacy `config.gateway` into `config.daemon` in place.
 * Pure: returns a new Config value; does not mutate input.
 * - If `daemon` already exists, drops `gateway` untouched.
 * - Otherwise moves `gateway` verbatim under `daemon`.
 */
export function migrateGatewayToDaemon(config: Config): Config {
  if (!config.gateway) return config;
  if (config.daemon) {
    const { gateway: _drop, ...rest } = config;
    return rest;
  }
  const { gateway, ...rest } = config;
  return { ...rest, daemon: gateway };
}
```

Then change `loadConfig` to apply it:

```ts
export async function loadConfig(): Promise<Config> {
  const vault = await loadVault();
  const migrated = migrateGatewayToDaemon(vault.config);
  // If migration changed anything, persist it.
  if (migrated !== vault.config) {
    await saveVault({
      version: CURRENT_VAULT_VERSION,
      config: migrated,
      credentials: vault.credentials,
    });
  }
  return migrated;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/config/config-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `bun test`
Expected: All existing tests still pass (no regressions from the loadConfig change).

- [ ] **Step 6: Commit**

```bash
git add src/config/config-manager.ts src/config/config-manager.test.ts
git commit -m "feat(daemon): migrate config.gateway to config.daemon on load"
```

---

## Task 3: Rename src/gateway → src/daemon (directory move, imports preserved)

**Files:**
- Rename: `src/gateway/*` → `src/daemon/*`
- Modify: every file importing from `../gateway/*` or `./gateway/*`

- [ ] **Step 1: Rename the directory**

```bash
git mv src/gateway src/daemon
```

- [ ] **Step 2: Update imports across the codebase**

```bash
rg -l "from ['\"].*gateway/" src | xargs sed -i '' "s|/gateway/|/daemon/|g"
rg -l "from ['\"].*\\.\\./gateway['\"]" src | xargs sed -i '' "s|../gateway|../daemon|g"
```

- [ ] **Step 3: Update re-export path in daemon types**

Edit `src/daemon/types.ts`. The existing line:

```ts
import type { ServiceName, GatewayConfig } from '../types/config';
```

Stays as-is (the type is still called `GatewayConfig` in `src/types/config.ts` — we only renamed the directory in this task).

- [ ] **Step 4: Verify with a clean typecheck**

Run: `bun run typecheck`
Expected: No errors related to the rename (existing unrelated errors, if any, are fine).

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(daemon): rename src/gateway to src/daemon"
```

---

## Task 4: Rename GatewayConfig type → DaemonConfig (keeping alias)

**Files:**
- Modify: `src/types/config.ts`, any file importing `GatewayConfig`

- [ ] **Step 1: Rename the interface and add a deprecated alias**

Edit `src/types/config.ts`. Rename `GatewayConfig` to `BaseDaemonConfig`, and re-express:

```ts
export interface BaseDaemonConfig {
  name?: string;
  apiUrl?: string;
  apiKey?: string;
  server?: GatewayServerConfig;
  webhook?: GatewayWebhookConfig;
  media?: GatewayMediaConfig;
  retention?: GatewayRetentionConfig;
}

/** @deprecated use DaemonConfig */
export type GatewayConfig = BaseDaemonConfig;

export interface DaemonConfig extends BaseDaemonConfig {
  scheduler?: SchedulerConfig;
}
```

(Task 1 already introduced `DaemonConfig`. This task formalizes the base.)

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: Passes. Existing code importing `GatewayConfig` still works via the alias.

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/types/config.ts
git commit -m "refactor(daemon): split BaseDaemonConfig, keep GatewayConfig alias"
```

---

## Task 5: Rename src/commands/gateway.ts → src/commands/daemon.ts

**Files:**
- Rename: `src/commands/gateway.ts` → `src/commands/daemon.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Rename the file**

```bash
git mv src/commands/gateway.ts src/commands/daemon.ts
```

- [ ] **Step 2: Rename the exported function**

Edit `src/commands/daemon.ts`. Change:

```ts
export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command('gateway')
    .description('Gateway daemon management');
```

to:

```ts
export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Daemon lifecycle management (messaging connections + scheduler)');
```

Then do a file-wide replace of the variable `gateway` → `daemon` inside this function scope **only** (not the string `gateway` in URLs like `/status` or config paths — those are handled in Task 6). Use your editor's "rename symbol" if available; otherwise do it manually and re-check each occurrence.

- [ ] **Step 3: Update the registration in `src/index.ts`**

Edit `src/index.ts`. Find:

```ts
import { registerGatewayCommands } from './commands/gateway';
```

Change to:

```ts
import { registerDaemonCommands } from './commands/daemon';
```

And update the call: `registerGatewayCommands(program)` → `registerDaemonCommands(program)`.

- [ ] **Step 4: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 5: Smoke test the rename**

Run: `bun run dev daemon --help`
Expected: Help text appears; subcommands include `install`, `start`, `stop`, `status`, `logs`, `uninstall`, `profile`, `teleport`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(daemon): rename commands/gateway.ts to commands/daemon.ts"
```

---

## Task 6: Update systemd service name and config keys inside daemon command

**Files:**
- Modify: `src/commands/daemon.ts`

- [ ] **Step 1: Update the systemd service constants**

Edit `src/commands/daemon.ts`. Change:

```ts
const SERVICE_NAME = 'agentio-gateway';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;
```

to:

```ts
const SERVICE_NAME = 'agentio-daemon';
const SERVICE_FILE = `/etc/systemd/system/${SERVICE_NAME}.service`;
const LEGACY_SERVICE_NAME = 'agentio-gateway';
const LEGACY_SERVICE_FILE = `/etc/systemd/system/${LEGACY_SERVICE_NAME}.service`;
```

And update `generateServiceFile`:

```ts
function generateServiceFile(binaryPath: string, configDir: string): string {
  return `[Unit]
Description=agentio daemon - messaging connections and scheduler
After=network.target

[Service]
Type=simple
ExecStart=${binaryPath} daemon start --foreground
Restart=always
RestartSec=5
Environment=HOME=${process.env.HOME}

[Install]
WantedBy=multi-user.target
`;
}
```

- [ ] **Step 2: Update `isServiceInstalled` to treat legacy as "installed" for start/stop only**

Edit `src/commands/daemon.ts`. Change:

```ts
function isServiceInstalled(): boolean {
  return existsSync(SERVICE_FILE);
}
```

to:

```ts
function isServiceInstalled(): boolean {
  return existsSync(SERVICE_FILE) || existsSync(LEGACY_SERVICE_FILE);
}

function activeServiceName(): string {
  return existsSync(SERVICE_FILE) ? SERVICE_NAME : LEGACY_SERVICE_NAME;
}
```

Replace every hardcoded `SERVICE_NAME` in start/stop/restart/status/logs/uninstall with `activeServiceName()`. Leave the **install** command using `SERVICE_NAME` — new installs always write the new unit.

- [ ] **Step 3: Make uninstall clean up both unit files**

Inside the `uninstall` action, replace:

```ts
const commands = [
  ['systemctl', 'stop', SERVICE_NAME],
  ['systemctl', 'disable', SERVICE_NAME],
  ['rm', SERVICE_FILE],
  ['systemctl', 'daemon-reload'],
];
```

with:

```ts
const active = activeServiceName();
const activeFile = active === SERVICE_NAME ? SERVICE_FILE : LEGACY_SERVICE_FILE;
const commands = [
  ['systemctl', 'stop', active],
  ['systemctl', 'disable', active],
  ['rm', activeFile],
  ['systemctl', 'daemon-reload'],
];
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/daemon.ts
git commit -m "refactor(daemon): rename systemd unit to agentio-daemon with legacy fallback"
```

---

## Task 7: Rename runtime data files (gateway.db → daemon.db, gateway.log → daemon.log)

**Files:**
- Modify: `src/daemon/store.ts`, `src/daemon/daemon.ts`

- [ ] **Step 1: Locate the DB/log paths**

Grep for the hardcoded names:

```bash
rg "gateway\\.(db|log)" src
```

Expected output: references in `src/daemon/store.ts` (DB path) and `src/daemon/daemon.ts` (LOG_FILE).

- [ ] **Step 2: Write a test for the rename-on-startup migration**

Create `src/daemon/path-migration.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateLegacyFiles } from './path-migration';

describe('migrateLegacyFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agentio-pm-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('renames gateway.db to daemon.db when target absent', () => {
    writeFileSync(join(dir, 'gateway.db'), 'dbcontent');
    migrateLegacyFiles(dir);
    expect(existsSync(join(dir, 'daemon.db'))).toBe(true);
    expect(existsSync(join(dir, 'gateway.db'))).toBe(false);
    expect(readFileSync(join(dir, 'daemon.db'), 'utf8')).toBe('dbcontent');
  });

  test('leaves gateway.db alone when daemon.db already exists', () => {
    writeFileSync(join(dir, 'gateway.db'), 'old');
    writeFileSync(join(dir, 'daemon.db'), 'new');
    migrateLegacyFiles(dir);
    expect(readFileSync(join(dir, 'gateway.db'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'daemon.db'), 'utf8')).toBe('new');
  });

  test('also migrates gateway.log', () => {
    writeFileSync(join(dir, 'gateway.log'), 'logs');
    migrateLegacyFiles(dir);
    expect(existsSync(join(dir, 'daemon.log'))).toBe(true);
  });

  test('no-op when neither exists', () => {
    migrateLegacyFiles(dir);
    expect(existsSync(join(dir, 'daemon.db'))).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/daemon/path-migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `path-migration.ts`**

Create `src/daemon/path-migration.ts`:

```ts
import { existsSync, renameSync } from 'fs';
import { join } from 'path';

const PAIRS: [string, string][] = [
  ['gateway.db', 'daemon.db'],
  ['gateway.log', 'daemon.log'],
];

/**
 * Rename legacy gateway.* files to daemon.* in the given config dir.
 * If both exist (unusual), the new one wins and the old is left alone.
 */
export function migrateLegacyFiles(configDir: string): void {
  for (const [from, to] of PAIRS) {
    const src = join(configDir, from);
    const dst = join(configDir, to);
    if (existsSync(src) && !existsSync(dst)) {
      renameSync(src, dst);
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/daemon/path-migration.test.ts`
Expected: PASS

- [ ] **Step 6: Update the store and daemon paths**

Edit `src/daemon/store.ts`. Find the DB path constant (search for `gateway.db`) and change to `daemon.db`.

Edit `src/daemon/daemon.ts`. Change:

```ts
const LOG_FILE = join(CONFIG_DIR, 'gateway.log');
```

to:

```ts
const LOG_FILE = join(CONFIG_DIR, 'daemon.log');
```

Then add at the top of `startDaemon()` (after `console.log('agentio-gateway starting...')` — also rename that log line):

```ts
import { migrateLegacyFiles } from './path-migration';
// ...
migrateLegacyFiles(CONFIG_DIR);
```

Rename the banner: `'agentio-gateway starting (PID ...)'` → `'agentio-daemon starting (PID ...)'`.

Also rename the exported function: `export async function startGateway(): Promise<void>` → `export async function startDaemon(): Promise<void>`. Update every caller (grep `startGateway` and rename).

- [ ] **Step 7: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(daemon): rename gateway.db/log to daemon.db/log with migration"
```

---

## Task 8: Rename the launchd label and plist label for the daemon

**Note:** Task 3 renamed the *directory*. This task adjusts the plist-building `LABEL_PREFIX` for the *daemon install* (macOS) — which is introduced in Task 10. It's a prep step.

**Files:**
- Create: `src/daemon/labels.ts`

- [ ] **Step 1: Create the labels module**

Create `src/daemon/labels.ts`:

```ts
/** Label for the agentio daemon LaunchAgent on macOS. */
export const DAEMON_LAUNCHD_LABEL = 'me.agentio.daemon';

/** Filename of the daemon plist under ~/Library/LaunchAgents. */
export const DAEMON_PLIST_FILE = `${DAEMON_LAUNCHD_LABEL}.plist`;
```

- [ ] **Step 2: Commit (no test needed — constants only)**

```bash
git add src/daemon/labels.ts
git commit -m "chore(daemon): add launchd label constants"
```

---

## Task 9: Pure function to build the daemon LaunchAgent plist dict

**Files:**
- Create: `src/daemon/daemon-plist.ts`, `src/daemon/daemon-plist.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/daemon/daemon-plist.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildDaemonPlist } from './daemon-plist';

describe('buildDaemonPlist', () => {
  test('includes Label, ProgramArguments, RunAtLoad, KeepAlive', () => {
    const dict = buildDaemonPlist({
      binaryPath: '/usr/local/bin/agentio',
      logPath: '/Users/me/.config/agentio/daemon.log',
      home: '/Users/me',
      extraPath: '/opt/homebrew/bin',
    });
    expect(dict.Label).toBe('me.agentio.daemon');
    expect(dict.ProgramArguments).toEqual([
      '/usr/local/bin/agentio',
      'daemon',
      'start',
      '--foreground',
    ]);
    expect(dict.RunAtLoad).toBe(true);
    expect(dict.KeepAlive).toBe(true);
    expect(dict.StandardOutPath).toBe('/Users/me/.config/agentio/daemon.log');
    expect(dict.StandardErrorPath).toBe('/Users/me/.config/agentio/daemon.log');
    expect(dict.WorkingDirectory).toBe('/Users/me');
    expect((dict.EnvironmentVariables as Record<string, string>).HOME).toBe('/Users/me');
    expect((dict.EnvironmentVariables as Record<string, string>).PATH).toContain('/opt/homebrew/bin');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/daemon-plist.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `daemon-plist.ts`**

Create `src/daemon/daemon-plist.ts`:

```ts
import { DAEMON_LAUNCHD_LABEL } from './labels';

export interface DaemonPlistInput {
  binaryPath: string;
  logPath: string;
  home: string;
  /** Extra PATH entries to prepend (e.g. /opt/homebrew/bin). Optional. */
  extraPath?: string;
}

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function buildDaemonPlist(input: DaemonPlistInput): Record<string, unknown> {
  const path = input.extraPath
    ? `${input.extraPath}:${DEFAULT_PATH}`
    : DEFAULT_PATH;

  return {
    Label: DAEMON_LAUNCHD_LABEL,
    ProgramArguments: [input.binaryPath, 'daemon', 'start', '--foreground'],
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: input.logPath,
    StandardErrorPath: input.logPath,
    WorkingDirectory: input.home,
    EnvironmentVariables: {
      HOME: input.home,
      PATH: path,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/daemon-plist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/daemon-plist.ts src/daemon/daemon-plist.test.ts
git commit -m "feat(daemon): add buildDaemonPlist pure function"
```

---

## Task 10: macOS install/uninstall path for the daemon

**Files:**
- Modify: `src/commands/daemon.ts`

- [ ] **Step 1: Add a darwin install helper**

Edit `src/commands/daemon.ts`. Add imports near the top:

```ts
import { homedir } from 'os';
import plist from 'plist';
import { writeFileSync as writeFileSyncPlain, unlinkSync } from 'fs';
import { buildDaemonPlist } from '../daemon/daemon-plist';
import { DAEMON_PLIST_FILE } from '../daemon/labels';
```

Add helpers above `registerDaemonCommands`:

```ts
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const DAEMON_PLIST_PATH = join(LAUNCH_AGENTS_DIR, DAEMON_PLIST_FILE);
const DAEMON_LOG_PATH = join(homedir(), '.config', 'agentio', 'daemon.log');

function isDaemonInstalledDarwin(): boolean {
  return existsSync(DAEMON_PLIST_PATH);
}

function installDaemonDarwin(): void {
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    require('fs').mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }
  const binaryPath = findBinaryPath();
  const extraPath = existsSync('/opt/homebrew/bin') ? '/opt/homebrew/bin' : undefined;
  const dict = buildDaemonPlist({
    binaryPath,
    logPath: DAEMON_LOG_PATH,
    home: homedir(),
    extraPath,
  });
  writeFileSyncPlain(DAEMON_PLIST_PATH, plist.build(dict as unknown as plist.PlistObject));

  // Load into launchd. Prefer modern `bootstrap`, fall back to `load`.
  const uid = spawnSync({ cmd: ['id', '-u'], stdout: 'pipe' }).stdout.toString().trim();
  const bootstrap = spawnSync({
    cmd: ['launchctl', 'bootstrap', `gui/${uid}`, DAEMON_PLIST_PATH],
    stdout: 'pipe', stderr: 'pipe',
  });
  if (bootstrap.exitCode !== 0) {
    const fallback = spawnSync({
      cmd: ['launchctl', 'load', DAEMON_PLIST_PATH],
      stdout: 'pipe', stderr: 'pipe',
    });
    if (fallback.exitCode !== 0) {
      try { unlinkSync(DAEMON_PLIST_PATH); } catch { /* ignore */ }
      throw new CliError(
        'CONFIG_ERROR',
        `launchctl failed: ${fallback.stderr.toString() || bootstrap.stderr.toString()}`,
      );
    }
  }
}

function uninstallDaemonDarwin(): void {
  if (!existsSync(DAEMON_PLIST_PATH)) return;
  const uid = spawnSync({ cmd: ['id', '-u'], stdout: 'pipe' }).stdout.toString().trim();
  spawnSync({
    cmd: ['launchctl', 'bootout', `gui/${uid}/${DAEMON_PLIST_FILE.replace('.plist', '')}`],
    stdout: 'pipe', stderr: 'pipe',
  });
  // Fallback unload for older macOS
  spawnSync({ cmd: ['launchctl', 'unload', DAEMON_PLIST_PATH], stdout: 'pipe', stderr: 'pipe' });
  try { unlinkSync(DAEMON_PLIST_PATH); } catch { /* ignore */ }
}
```

- [ ] **Step 2: Branch install/uninstall on platform**

In the `install` command action, replace the Linux-specific body with:

```ts
.action(async () => {
  try {
    if (process.platform === 'darwin') {
      console.log('Installing agentio daemon LaunchAgent...');
      // Ensure the apiKey exists before starting
      const config = await loadConfig() as Config;
      if (!config.daemon?.apiKey) {
        const apiKey = `gw_${randomBytes(24).toString('base64url')}`;
        config.daemon = { ...config.daemon, apiKey };
        await saveConfig(config);
        console.log(`Generated API key: ${apiKey}`);
      }
      installDaemonDarwin();
      console.log('Installed and running via launchd.');
      console.log(`Plist:  ${DAEMON_PLIST_PATH}`);
      console.log(`Logs:   ${DAEMON_LOG_PATH}`);
      return;
    }
    if (process.platform === 'linux') {
      // Keep the existing Linux/systemd install body verbatim from the pre-rename
      // code. It already uses SERVICE_NAME / SERVICE_FILE (updated in Task 6) and
      // `binaryPath daemon start --foreground` (updated in Task 6's generateServiceFile).
      // No other Linux-specific changes are needed in this task.
      return;
    }
    throw new CliError('CONFIG_ERROR',
      `agentio daemon install is not supported on ${process.platform}`,
      'Run the daemon manually with `agentio daemon start --foreground`');
  } catch (error) {
    handleError(error);
  }
});
```

In `uninstall`, similarly branch:

```ts
.action(async () => {
  try {
    if (process.platform === 'darwin') {
      if (!isDaemonInstalledDarwin()) {
        console.log('Daemon LaunchAgent not installed');
        return;
      }
      uninstallDaemonDarwin();
      console.log('Daemon LaunchAgent removed');
      console.log('\nConfiguration and data files are preserved in ~/.config/agentio/');
      return;
    }
    if (process.platform === 'linux') {
      // existing systemd uninstall body
      return;
    }
    throw new CliError('CONFIG_ERROR', `Not supported on ${process.platform}`);
  } catch (error) {
    handleError(error);
  }
});
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Smoke test (do NOT actually install)**

Run: `bun run dev daemon install --help`
Expected: Help prints without error.

- [ ] **Step 5: Commit**

```bash
git add src/commands/daemon.ts
git commit -m "feat(daemon): macOS install path via LaunchAgent"
```

---

## Task 11: Cross-platform daemon start/stop/status/logs branching

**Files:**
- Modify: `src/commands/daemon.ts`

- [ ] **Step 1: Add darwin start/stop helpers**

At the top of `src/commands/daemon.ts`, add:

```ts
function daemonStartDarwin(): void {
  const uid = spawnSync({ cmd: ['id', '-u'], stdout: 'pipe' }).stdout.toString().trim();
  // Try kickstart (modern), fall back to load.
  const kick = spawnSync({
    cmd: ['launchctl', 'kickstart', '-k', `gui/${uid}/${DAEMON_PLIST_FILE.replace('.plist', '')}`],
    stdout: 'pipe', stderr: 'pipe',
  });
  if (kick.exitCode !== 0) {
    spawnSync({ cmd: ['launchctl', 'load', DAEMON_PLIST_PATH], stdout: 'pipe', stderr: 'pipe' });
  }
}

function daemonStopDarwin(): void {
  const uid = spawnSync({ cmd: ['id', '-u'], stdout: 'pipe' }).stdout.toString().trim();
  const stop = spawnSync({
    cmd: ['launchctl', 'bootout', `gui/${uid}/${DAEMON_PLIST_FILE.replace('.plist', '')}`],
    stdout: 'pipe', stderr: 'pipe',
  });
  if (stop.exitCode !== 0) {
    spawnSync({ cmd: ['launchctl', 'unload', DAEMON_PLIST_PATH], stdout: 'pipe', stderr: 'pipe' });
  }
}
```

- [ ] **Step 2: Branch `start`, `stop`, `restart`, `logs` on platform**

In the `start` command action, add darwin branch **before** the systemd branch:

```ts
if (options.foreground) {
  await startDaemon();
  return;
}
if (process.platform === 'darwin') {
  if (!isDaemonInstalledDarwin()) {
    // Not installed: run in foreground like systemd does
    await startDaemon();
    return;
  }
  daemonStartDarwin();
  console.log('Daemon started (launchd)');
  return;
}
// ... existing systemd branch
```

`stop` becomes:

```ts
if (process.platform === 'darwin') {
  if (!isDaemonInstalledDarwin()) {
    console.log('Daemon LaunchAgent not installed');
    return;
  }
  daemonStopDarwin();
  console.log('Daemon stopped');
  return;
}
// ... existing systemd branch
```

`restart` is stop+start in sequence, branched the same way.

`logs`: if darwin and installed, `tail -f ~/.config/agentio/daemon.log` via `Bun.spawn`. If linux, keep the `journalctl` path.

- [ ] **Step 3: Cross-platform status via HTTP /health**

Replace the systemd-specific `status` action with a health-probe-first approach:

```ts
.action(async () => {
  try {
    const gatewayConfig = await getGatewayConfig();
    const port = gatewayConfig.server?.port ?? 7890;
    let running = false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: gatewayConfig.apiKey ? { 'X-API-Key': gatewayConfig.apiKey } : {},
        signal: AbortSignal.timeout(1500),
      });
      running = res.ok;
    } catch { /* not running */ }

    if (running) {
      console.log('Daemon: running');
      // existing /status-based adapter listing ...
      return;
    }

    // Not running — report install state
    const installed = process.platform === 'darwin'
      ? isDaemonInstalledDarwin()
      : isServiceInstalled();
    if (installed) {
      console.log('Daemon: installed but not running');
      console.log('Start it with: agentio daemon start');
    } else {
      console.log('Daemon: not installed');
      console.log('Install with: agentio daemon install');
    }
  } catch (error) {
    handleError(error);
  }
});
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/daemon.ts
git commit -m "feat(daemon): cross-platform start/stop/status/logs"
```

---

## Task 12: Add `gateway` command alias with deprecation warning

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the alias after `registerDaemonCommands`**

Edit `src/index.ts`. Below the call to `registerDaemonCommands(program)`, add:

```ts
// Legacy alias — `agentio gateway ...` forwards to `agentio daemon ...`
// with a stderr deprecation warning. Remove in a future release.
const legacyGateway = program
  .command('gateway', { hidden: true })
  .description('[deprecated] alias of `agentio daemon`');
legacyGateway.hook('preAction', () => {
  console.error('warning: `agentio gateway` is deprecated; use `agentio daemon` instead.');
});
// Re-register the same subcommands under the gateway prefix by cloning
// the daemon command tree. Simplest implementation: re-invoke
// registerDaemonCommands with an override flag.
```

Since Commander.js doesn't easily support aliasing a whole command tree, we pull the alias in at the subcommand level. Update `registerDaemonCommands` in `src/commands/daemon.ts` to accept an optional base name:

```ts
export function registerDaemonCommands(
  program: Command,
  opts: { base?: string; deprecated?: boolean } = {}
): void {
  const baseName = opts.base ?? 'daemon';
  const description = opts.deprecated
    ? '[deprecated] alias of `agentio daemon`'
    : 'Daemon lifecycle management (messaging connections + scheduler)';
  const daemon = program
    .command(baseName)
    .description(description);

  if (opts.deprecated) {
    daemon.hook('preAction', () => {
      console.error(`warning: \`agentio ${baseName}\` is deprecated; use \`agentio daemon\` instead.`);
    });
  }
  // ... rest of the existing function body uses `daemon` as before
}
```

In `src/index.ts`:

```ts
registerDaemonCommands(program);
registerDaemonCommands(program, { base: 'gateway', deprecated: true });
```

Remove the earlier `legacyGateway` scaffold added above.

- [ ] **Step 2: Smoke-test both roots**

```bash
bun run dev daemon --help
bun run dev gateway --help
```
Expected: both print help; `gateway` output is under `[deprecated]`.

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(daemon): register legacy `gateway` alias with deprecation warning"
```

---

## Task 13: Pure scheduler-core functions (scanWatchedFolders, dueJobs, computeCatchUp)

**Files:**
- Create: `src/daemon/scheduler-core.ts`, `src/daemon/scheduler-core.test.ts`

- [ ] **Step 1: Write tests for `scanWatchedFolders`**

Create `src/daemon/scheduler-core.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WatchedFolder } from '../types/config';
import {
  scanWatchedFolders,
  dueJobs,
  computeCatchUp,
  type ScheduledJob,
} from './scheduler-core';

describe('scanWatchedFolders', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agentio-sch-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function write(rel: string, content: string): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }

  test('builds jobs from all watched folders', () => {
    write('foo.run.md',
      '---\nschedule:\n  type: interval\n  intervalMinutes: 30\nenabled: true\n---\nbody\n');
    const folders: WatchedFolder[] = [{ path: root, addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'my-host', new Date('2026-04-24T10:00:00Z'));
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe('foo');
    expect(jobs[0].folder).toBe(root);
    expect(jobs[0].config.schedule.type).toBe('interval');
  });

  test('skips folders pinned to other hosts', () => {
    write('x.run.md',
      '---\nschedule:\n  type: daily\n  hour: 9\n  minute: 0\n---\n');
    const folders: WatchedFolder[] = [{ path: root, host: 'other-host', addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'my-host', new Date());
    expect(jobs.length).toBe(0);
  });

  test('skips files pinned to other hosts', () => {
    write('x.run.md',
      '---\nschedule:\n  type: daily\n  hour: 9\n  minute: 0\nhost: elsewhere\n---\n');
    const folders: WatchedFolder[] = [{ path: root, addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'me', new Date());
    expect(jobs.length).toBe(0);
  });

  test('skips disabled schedules', () => {
    write('x.run.md',
      '---\nschedule:\n  type: daily\n  hour: 9\n  minute: 0\nenabled: false\n---\n');
    const folders: WatchedFolder[] = [{ path: root, addedAt: 0 }];
    const jobs = scanWatchedFolders(folders, 'me', new Date());
    expect(jobs.length).toBe(0);
  });
});

describe('dueJobs', () => {
  test('returns jobs whose nextRun <= now', () => {
    const now = new Date('2026-04-24T10:00:00Z');
    const jobs: ScheduledJob[] = [
      { folder: '/a', id: 'x', filePath: '/a/x.run.md',
        config: {} as any, nextRun: new Date('2026-04-24T09:59:00Z') },
      { folder: '/a', id: 'y', filePath: '/a/y.run.md',
        config: {} as any, nextRun: new Date('2026-04-24T10:01:00Z') },
    ];
    const due = dueJobs(jobs, now);
    expect(due.map((j) => j.id)).toEqual(['x']);
  });
});

describe('computeCatchUp', () => {
  test('returns true when lastRunAt is before the previous expected fire', () => {
    // Interval every 30m, lastRun was 2h ago, now = 2h after last expected fire
    const now = new Date('2026-04-24T10:00:00Z');
    const lastRunAt = new Date('2026-04-24T08:00:00Z').toISOString();
    const result = computeCatchUp(
      { type: 'interval', intervalMinutes: 30 },
      lastRunAt,
      now,
    );
    expect(result).toBe(true);
  });

  test('returns false when lastRunAt is after the previous expected fire', () => {
    const now = new Date('2026-04-24T10:00:00Z');
    const lastRunAt = new Date('2026-04-24T09:45:00Z').toISOString();
    const result = computeCatchUp(
      { type: 'interval', intervalMinutes: 30 },
      lastRunAt,
      now,
    );
    expect(result).toBe(false);
  });

  test('returns false when lastRunAt is undefined (first run)', () => {
    const result = computeCatchUp(
      { type: 'interval', intervalMinutes: 30 },
      undefined,
      new Date(),
    );
    expect(result).toBe(false);
  });

  test('returns false for manual schedules', () => {
    const result = computeCatchUp(
      { type: 'manual' },
      new Date('2026-01-01').toISOString(),
      new Date('2026-04-24'),
    );
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/scheduler-core.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scheduler-core.ts`**

Create `src/daemon/scheduler-core.ts`:

```ts
import { readFileSync } from 'fs';
import type { WatchedFolder } from '../types/config';
import type { FrontmatterConfig, Schedule } from '../types/schedule';
import { walkRunFiles } from '../services/schedule/walker';
import { mergeConfig, parseFrontmatter } from '../services/schedule/frontmatter';
import { hostMatches } from '../services/schedule/host';
import { nextRuns, prevRun } from '../services/schedule/schedule-calculator';

export interface ScheduledJob {
  folder: string;
  id: string;
  filePath: string;
  config: FrontmatterConfig;
  nextRun: Date;
}

/**
 * Scan all watched folders, parse each `.run.md`, and build ScheduledJobs
 * for schedules that are enabled and match the current host.
 * Parse errors are silently skipped (caller logs).
 */
export function scanWatchedFolders(
  folders: WatchedFolder[],
  currentHost: string,
  now: Date,
): ScheduledJob[] {
  const out: ScheduledJob[] = [];
  for (const f of folders) {
    if (f.host && f.host !== currentHost) continue;
    let files;
    try { files = walkRunFiles(f.path); } catch { continue; }
    for (const file of files) {
      let raw: string;
      try { raw = readFileSync(file.path, 'utf-8'); } catch { continue; }
      let parsed;
      try { parsed = parseFrontmatter(raw); } catch { continue; }
      const cfg = mergeConfig({}, parsed.config);
      if (!cfg.enabled) continue;
      if (!hostMatches(cfg, currentHost)) continue;
      const next = nextRuns(cfg.schedule, 1, now)[0];
      if (!next) continue;  // manual schedules
      out.push({
        folder: f.path,
        id: file.id,
        filePath: file.path,
        config: cfg,
        nextRun: next,
      });
    }
  }
  return out;
}

/** Return jobs whose nextRun <= now. */
export function dueJobs(jobs: ScheduledJob[], now: Date): ScheduledJob[] {
  return jobs.filter((j) => j.nextRun.getTime() <= now.getTime());
}

/**
 * Decide if a schedule needs a catch-up fire.
 * True iff the most recent expected fire before `now` is *after* `lastRunAt`.
 */
export function computeCatchUp(
  schedule: Schedule,
  lastRunAtIso: string | undefined,
  now: Date,
): boolean {
  if (schedule.type === 'manual') return false;
  if (!lastRunAtIso) return false;
  const prev = prevRun(schedule, now);
  if (!prev) return false;
  return new Date(lastRunAtIso).getTime() < prev.getTime();
}
```

- [ ] **Step 4: Add `prevRun` to the calculator**

Confirm it does not yet exist:

```bash
grep "export function prevRun" src/services/schedule/schedule-calculator.ts
```

Expected: no output. Then add a companion test in `src/services/schedule/schedule-calculator.test.ts`:

```ts
import { prevRun } from './schedule-calculator';

describe('prevRun', () => {
  test('returns null for manual', () => {
    expect(prevRun({ type: 'manual' }, new Date())).toBeNull();
  });

  test('daily: returns today at H:M if now is past, else yesterday', () => {
    const now = new Date('2026-04-24T10:00:00Z');
    expect(prevRun({ type: 'daily', hour: 9, minute: 0 }, now)?.toISOString())
      .toBe('2026-04-24T09:00:00.000Z');
    expect(prevRun({ type: 'daily', hour: 11, minute: 0 }, now)?.toISOString())
      .toBe('2026-04-23T11:00:00.000Z');
  });

  test('interval: returns floor(now / interval)', () => {
    const now = new Date('2026-04-24T10:07:00Z');
    const result = prevRun({ type: 'interval', intervalMinutes: 30 }, now);
    expect(result?.toISOString()).toBe('2026-04-24T10:00:00.000Z');
  });
});
```

Implement `prevRun` in `src/services/schedule/schedule-calculator.ts`. Study the existing `nextRuns` implementation for the exact semantics of each schedule type, then mirror the logic backwards. Return `null` for `manual`. Run the test to verify, then continue to the next step.

- [ ] **Step 5: Also check mergeConfig signature**

```bash
grep "export function mergeConfig" src/services/schedule/frontmatter.ts
```

Confirm it takes `(defaults, override)` and returns a fully-defaulted `FrontmatterConfig`. If not, adapt the call in step 3 accordingly.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/daemon/scheduler-core.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(scheduler): pure scan/due/catch-up functions"
```

---

## Task 14: Scheduler lifecycle module

**Files:**
- Create: `src/daemon/scheduler.ts`, `src/daemon/scheduler.test.ts`

- [ ] **Step 1: Write an integration test with injected spawner**

Create `src/daemon/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import { startScheduler, stopScheduler, _testHooks } from './scheduler';

function fakeChild() {
  const c = new EventEmitter() as any;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  setImmediate(() => c.emit('close', 0));
  return c;
}

describe('scheduler', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentio-sch-'));
  });
  afterEach(async () => {
    await stopScheduler();
    rmSync(root, { recursive: true, force: true });
  });

  test('fires a due interval schedule on tick', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 1\nenabled: true\n---\nbody\n');

    const spawns: { folder: string; id: string }[] = [];
    const spawner = (_cmd: string, _args: string[], opts: { cwd: string }) => {
      spawns.push({ folder: opts.cwd, id: 'x' });
      return fakeChild();
    };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 50,
      spawner,
      claudePath: '/bin/true',  // non-null so runSchedule proceeds
      now: () => new Date(),
    });

    // Wait two ticks
    await new Promise((r) => setTimeout(r, 200));

    expect(spawns.length).toBeGreaterThanOrEqual(1);
    expect(spawns[0].folder).toBe(root);
  });

  test('skips a second fire when a run is still in flight', async () => {
    writeFileSync(join(root, 'x.run.md'),
      '---\nschedule:\n  type: interval\n  intervalMinutes: 1\nenabled: true\n---\nbody\n');

    let closeResolver: (() => void) | null = null;
    const spawns: number = 0;
    const counter = { n: 0 };
    const spawner = () => {
      counter.n += 1;
      const c = new EventEmitter() as any;
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      closeResolver = () => c.emit('close', 0);
      return c;
    };

    await startScheduler({
      watchedFolders: [{ path: root, addedAt: 0 }],
      currentHost: 'h1',
      tickIntervalMs: 30,
      spawner,
      claudePath: '/bin/true',
      now: () => new Date(),
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(counter.n).toBe(1);  // in-flight, not re-spawned
    closeResolver?.();
    await new Promise((r) => setTimeout(r, 100));
    expect(counter.n).toBeGreaterThan(1);  // now eligible again
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/daemon/scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scheduler.ts`**

Create `src/daemon/scheduler.ts`:

```ts
import type { WatchedFolder } from '../types/config';
import { readFile } from 'fs/promises';
import { scanWatchedFolders, dueJobs, computeCatchUp, type ScheduledJob } from './scheduler-core';
import { runSchedule, type Spawner } from '../services/schedule/runner';
import { readState } from '../services/schedule/state';
import { parseFrontmatter } from '../services/schedule/frontmatter';
import { getCurrentHost } from '../services/schedule/host';

export interface StartSchedulerOpts {
  watchedFolders: WatchedFolder[];
  currentHost?: string;
  tickIntervalMs?: number;
  /** injected for tests; defaults to child_process.spawn */
  spawner?: Spawner;
  /** injected for tests; defaults to locateClaude() */
  claudePath?: string | null;
  /** injected for tests */
  now?: () => Date;
}

let tickInterval: ReturnType<typeof setInterval> | null = null;
let inFlight: Set<string> = new Set();  // keys: `${folder}::${id}`
let catchUpApplied: Set<string> = new Set();
let currentOpts: StartSchedulerOpts | null = null;

function jobKey(j: ScheduledJob): string {
  return `${j.folder}::${j.id}`;
}

async function fireJob(job: ScheduledJob, opts: StartSchedulerOpts): Promise<void> {
  const key = jobKey(job);
  if (inFlight.has(key)) {
    console.log(`[scheduler] skipped ${job.id} (still running)`);
    return;
  }
  inFlight.add(key);
  try {
    const raw = await readFile(job.filePath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    await runSchedule({
      folder: job.folder,
      id: job.id,
      promptBody: parsed.body,
      config: job.config,
      quiet: true,
      spawner: opts.spawner,
      claudePath: opts.claudePath,
      now: opts.now,
    });
  } catch (e) {
    console.error(`[scheduler] fire failed for ${job.id}:`, e instanceof Error ? e.message : e);
  } finally {
    inFlight.delete(key);
  }
}

async function tick(opts: StartSchedulerOpts): Promise<void> {
  const now = (opts.now ?? (() => new Date()))();
  const host = opts.currentHost ?? getCurrentHost();
  const jobs = scanWatchedFolders(opts.watchedFolders, host, now);

  // Missed-runs catch-up, one per id per startup.
  for (const j of jobs) {
    const key = jobKey(j);
    if (catchUpApplied.has(key)) continue;
    const state = await readState(j.folder).catch(() => ({}));
    const lastRunAt = state[j.id]?.lastRunAt;
    if (computeCatchUp(j.config.schedule, lastRunAt, now)) {
      console.log(`[scheduler] catch-up firing ${j.id}`);
      fireJob(j, opts);  // fire-and-forget
    }
    catchUpApplied.add(key);
  }

  // Due-this-tick fires.
  const due = dueJobs(jobs, now);
  for (const j of due) {
    fireJob(j, opts);  // fire-and-forget
  }
}

export async function startScheduler(opts: StartSchedulerOpts): Promise<void> {
  if (tickInterval) throw new Error('scheduler already started');
  currentOpts = opts;
  const intervalMs = opts.tickIntervalMs ?? 60_000;
  await tick(opts);
  tickInterval = setInterval(() => { tick(opts).catch(console.error); }, intervalMs);
}

export async function reloadScheduler(watchedFolders: WatchedFolder[]): Promise<void> {
  if (!currentOpts) return;
  currentOpts = { ...currentOpts, watchedFolders };
  await tick(currentOpts);
}

export async function stopScheduler(): Promise<void> {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  // Wait up to 30s for in-flight runs
  const deadline = Date.now() + 30_000;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  inFlight.clear();
  catchUpApplied.clear();
  currentOpts = null;
}

export const _testHooks = {
  getInFlight: () => new Set(inFlight),
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/daemon/scheduler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/scheduler.ts src/daemon/scheduler.test.ts
git commit -m "feat(scheduler): lifecycle module with tick loop and catch-up"
```

---

## Task 15: Wire scheduler into daemon startup/shutdown

**Files:**
- Modify: `src/daemon/daemon.ts`

- [ ] **Step 1: Import the scheduler**

Edit `src/daemon/daemon.ts`. At the top, add:

```ts
import { startScheduler, stopScheduler } from './scheduler';
```

- [ ] **Step 2: Start the scheduler after adapters/API are ready**

Inside `startDaemon()`, after `startApiServer(...)`, add:

```ts
// Start scheduler
const scheduler = gatewayConfig.scheduler ?? {};
const folders = scheduler.watchedFolders ?? [];
if (folders.length > 0) {
  const tickMs = (scheduler.tickIntervalSec ?? 60) * 1000;
  await startScheduler({
    watchedFolders: folders,
    tickIntervalMs: tickMs,
  });
  console.log(`[scheduler] watching ${folders.length} folder(s), tick=${tickMs}ms`);
} else {
  console.log('[scheduler] no watched folders');
}
```

**Note:** the variable `gatewayConfig` in this file still comes from `config.gateway` / `config.daemon` merged. Verify it typed as `DaemonConfig` (change the type assertion in `loadConfig() as Config` path: the field is now `config.daemon`, not `config.gateway`). Update:

```ts
let gatewayConfig = config.gateway ?? {};
```

to:

```ts
let gatewayConfig: DaemonConfig = config.daemon ?? {};
```

And update the save path:

```ts
config.daemon = gatewayConfig;
await saveConfig(config);
```

Import `DaemonConfig` from `../types/config`.

- [ ] **Step 3: Stop the scheduler during shutdown**

Inside the `shutdown` callback, add **before** `shutdownAdapters()`:

```ts
await stopScheduler();
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/daemon.ts
git commit -m "feat(daemon): start and stop the scheduler with the daemon"
```

---

## Task 16: HTTP endpoint POST /scheduler/reload

**Files:**
- Modify: `src/daemon/api.ts`

- [ ] **Step 1: Add the route**

Edit `src/daemon/api.ts`. Find the HTTP router (look for existing route strings like `/status` or `/inbox/pull`). Add a handler for `POST /scheduler/reload`:

```ts
// Inside the fetch handler, after existing routes:
if (request.method === 'POST' && url.pathname === '/scheduler/reload') {
  if (!authOk(request)) return new Response('Unauthorized', { status: 401 });
  const config = await loadConfig();
  const folders = config.daemon?.scheduler?.watchedFolders ?? [];
  const { reloadScheduler } = await import('./scheduler');
  await reloadScheduler(folders);
  return Response.json({ folders: folders.length });
}
```

(`authOk` is the existing helper — use whatever pattern the file already establishes; if the file checks `X-API-Key` inline, replicate inline.)

- [ ] **Step 2: Add an integration test**

Append to (or create) `src/daemon/api.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

describe('POST /scheduler/reload', () => {
  test('responds with folder count when authorized', async () => {
    // Boot a minimal API server with a known key and a stub reloadScheduler.
    // See existing gateway API tests for the harness pattern.
    // If no prior api tests exist, skip this step and lean on the
    // scheduler.test.ts coverage instead; the route is thin.
  });
});
```

If there's no existing `api.test.ts` harness, skip the automated test and rely on the smoke test in step 3.

- [ ] **Step 3: Smoke test**

```bash
# In one terminal:
bun run dev daemon start --foreground
# In another:
curl -X POST http://127.0.0.1:7890/scheduler/reload \
  -H "X-API-Key: $(bun run dev -- --config-key)"
```

Expected: `{"folders":0}` if no folders configured yet.

- [ ] **Step 4: Commit**

```bash
git add src/daemon/api.ts
git commit -m "feat(api): POST /scheduler/reload route"
```

---

## Task 17: HTTP endpoint GET /scheduler/list

**Files:**
- Modify: `src/daemon/api.ts`, `src/daemon/scheduler.ts`

- [ ] **Step 1: Expose a `listJobs()` API from the scheduler**

Edit `src/daemon/scheduler.ts`. Add:

```ts
import { readState } from '../services/schedule/state';

export interface SchedulerJobView {
  folder: string;
  id: string;
  schedule: string;            // humanized
  enabled: boolean;
  nextRun: string;             // ISO
  lastRunAt?: string;
  lastExitCode?: number;
  isRunning: boolean;
}

export async function listSchedulerJobs(): Promise<SchedulerJobView[]> {
  if (!currentOpts) return [];
  const host = currentOpts.currentHost ?? getCurrentHost();
  const now = (currentOpts.now ?? (() => new Date()))();
  const jobs = scanWatchedFolders(currentOpts.watchedFolders, host, now);
  const out: SchedulerJobView[] = [];
  for (const j of jobs) {
    const state = await readState(j.folder).catch(() => ({}));
    out.push({
      folder: j.folder,
      id: j.id,
      schedule: humanSchedule(j.config.schedule),
      enabled: j.config.enabled,
      nextRun: j.nextRun.toISOString(),
      lastRunAt: state[j.id]?.lastRunAt,
      lastExitCode: state[j.id]?.lastExitCode,
      isRunning: inFlight.has(jobKey(j)),
    });
  }
  return out;
}

function humanSchedule(s: import('../types/schedule').Schedule): string {
  // Reuse the existing describeSchedule from commands/schedule.ts.
  // Extract it into src/services/schedule/describe.ts first (Task 17b).
}
```

- [ ] **Step 2 (17b): Extract `describeSchedule` into a reusable module**

Currently `describeSchedule` lives in `src/commands/schedule.ts`. Move it into a new file `src/services/schedule/describe.ts`:

```ts
import type { Schedule } from '../../types/schedule';
import { weekdayNames } from './weekdays';

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'manual': return 'Manual';
    case 'daily': return `Daily at ${fmtHM(s.hour, s.minute)}`;
    case 'weekly': return `Weekly ${weekdayNames(s.weekdays ?? [])} at ${fmtHM(s.hour, s.minute)}`;
    case 'monthly': return `Monthly on day ${s.day} at ${fmtHM(s.hour, s.minute)}`;
    case 'interval': {
      const m = s.intervalMinutes ?? 0;
      if (m < 60) return `Every ${m}m`;
      if (m % 60 === 0) return `Every ${m / 60}h`;
      return `Every ${Math.floor(m / 60)}h${m % 60}m`;
    }
  }
}

function fmtHM(h?: number, m?: number): string {
  return `${String(h ?? 0).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
}
```

Update `src/commands/schedule.ts` to `import { describeSchedule } from '../services/schedule/describe'` and remove the local copy. Update `src/daemon/scheduler.ts` to import from the same place (replace the `humanSchedule` local stub).

- [ ] **Step 3: Add the route**

In `src/daemon/api.ts`, add:

```ts
if (request.method === 'GET' && url.pathname === '/scheduler/list') {
  if (!authOk(request)) return new Response('Unauthorized', { status: 401 });
  const { listSchedulerJobs } = await import('./scheduler');
  const jobs = await listSchedulerJobs();
  return Response.json({ jobs });
}
```

- [ ] **Step 4: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS (existing `describeSchedule` callers keep working).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(api): GET /scheduler/list with extracted describeSchedule"
```

---

## Task 18: HTTP endpoint POST /scheduler/run

**Files:**
- Modify: `src/daemon/api.ts`, `src/daemon/scheduler.ts`

- [ ] **Step 1: Expose `runOneJob()` from the scheduler**

Edit `src/daemon/scheduler.ts`. Add:

```ts
export async function runOneJob(folder: string, id: string): Promise<{
  started: boolean;
  reason?: string;
}> {
  if (!currentOpts) return { started: false, reason: 'scheduler not running' };
  const host = currentOpts.currentHost ?? getCurrentHost();
  const jobs = scanWatchedFolders(currentOpts.watchedFolders, host, new Date());
  const job = jobs.find((j) => j.folder === folder && j.id === id);
  if (!job) return { started: false, reason: 'job not found or disabled' };
  if (inFlight.has(jobKey(job))) return { started: false, reason: 'already running' };
  fireJob(job, currentOpts);  // fire-and-forget
  return { started: true };
}
```

- [ ] **Step 2: Add the route**

In `src/daemon/api.ts`:

```ts
if (request.method === 'POST' && url.pathname === '/scheduler/run') {
  if (!authOk(request)) return new Response('Unauthorized', { status: 401 });
  const { folder, id } = await request.json() as { folder: string; id: string };
  if (!folder || !id) return new Response('missing folder or id', { status: 400 });
  const { runOneJob } = await import('./scheduler');
  const result = await runOneJob(folder, id);
  return Response.json(result);
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(api): POST /scheduler/run endpoint"
```

---

## Task 19: `schedule watch <folder>` command

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Write a test for the config-persistence behavior**

Append to `src/commands/schedule.test.ts` (or create it):

```ts
import { describe, expect, test } from 'bun:test';
import { addWatchedFolder, removeWatchedFolder } from './schedule-watch';
import type { Config, WatchedFolder } from '../types/config';

describe('addWatchedFolder', () => {
  test('appends when folder is new', () => {
    const c: Config = { profiles: {} };
    const out = addWatchedFolder(c, '/tmp/a', 'h1', 1000);
    expect(out.daemon?.scheduler?.watchedFolders).toEqual([
      { path: '/tmp/a', host: 'h1', addedAt: 1000 },
    ]);
  });

  test('is idempotent by path', () => {
    const c: Config = {
      profiles: {},
      daemon: { scheduler: { watchedFolders: [{ path: '/tmp/a', addedAt: 1 }] } },
    };
    const out = addWatchedFolder(c, '/tmp/a', 'h1', 2);
    expect(out.daemon?.scheduler?.watchedFolders?.length).toBe(1);
  });
});

describe('removeWatchedFolder', () => {
  test('removes by exact path', () => {
    const c: Config = {
      profiles: {},
      daemon: { scheduler: { watchedFolders: [
        { path: '/tmp/a', addedAt: 1 },
        { path: '/tmp/b', addedAt: 2 },
      ] } },
    };
    const out = removeWatchedFolder(c, '/tmp/a');
    expect(out.daemon?.scheduler?.watchedFolders).toEqual([
      { path: '/tmp/b', addedAt: 2 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/commands/schedule.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helpers**

Create `src/commands/schedule-watch.ts`:

```ts
import type { Config, WatchedFolder } from '../types/config';

export function addWatchedFolder(
  config: Config,
  path: string,
  host: string | undefined,
  addedAt: number,
): Config {
  const daemon = config.daemon ?? {};
  const scheduler = daemon.scheduler ?? {};
  const folders = scheduler.watchedFolders ?? [];
  if (folders.find((f) => f.path === path)) return config;
  const newFolder: WatchedFolder = { path, addedAt, ...(host ? { host } : {}) };
  return {
    ...config,
    daemon: {
      ...daemon,
      scheduler: { ...scheduler, watchedFolders: [...folders, newFolder] },
    },
  };
}

export function removeWatchedFolder(config: Config, path: string): Config {
  const daemon = config.daemon ?? {};
  const scheduler = daemon.scheduler ?? {};
  const folders = scheduler.watchedFolders ?? [];
  const next = folders.filter((f) => f.path !== path);
  return {
    ...config,
    daemon: {
      ...daemon,
      scheduler: { ...scheduler, watchedFolders: next },
    },
  };
}
```

- [ ] **Step 4: Run the test**

Run: `bun test src/commands/schedule.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the CLI command**

Edit `src/commands/schedule.ts`. Add imports:

```ts
import { addWatchedFolder, removeWatchedFolder } from './schedule-watch';
import { getCurrentHost } from '../services/schedule/host';
```

Inside `registerScheduleCommands`, add:

```ts
schedule.command('watch').description('Register a folder for the agentio daemon to scan')
  .argument('<folder>', 'Folder to watch (absolute or relative)')
  .option('--no-host-pin', 'Do not pin this folder to the current host')
  .action(async (folder: string, opts: { hostPin: boolean }) => {
    try {
      const absPath = resolve(folder);
      if (!existsSync(absPath)) {
        throw new CliError('NOT_FOUND', `Folder does not exist: ${absPath}`);
      }
      const config = await loadConfig();
      const host = opts.hostPin === false ? undefined : getCurrentHost();
      const updated = addWatchedFolder(config, absPath, host, Date.now());
      await saveConfig(updated);

      const apiKey = updated.daemon?.apiKey;
      const port = updated.daemon?.server?.port ?? 7890;

      // Try to reload the daemon
      let daemonAlive = false;
      if (apiKey) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/scheduler/reload`, {
            method: 'POST',
            headers: { 'X-API-Key': apiKey },
            signal: AbortSignal.timeout(1500),
          });
          daemonAlive = res.ok;
        } catch { /* daemon not up */ }
      }

      console.log(`Watching ${abbrHome(absPath)}${host ? ` (pinned to ${host})` : ''}.`);
      if (daemonAlive) {
        console.log('Daemon reloaded — new schedules will fire immediately.');
      } else {
        // Check install state and suggest
        const installed = process.platform === 'darwin'
          ? existsSync(join(homedir(), 'Library', 'LaunchAgents', 'me.agentio.daemon.plist'))
          : existsSync('/etc/systemd/system/agentio-daemon.service');
        if (!installed) {
          console.log('The agentio daemon is not installed.');
          console.log('Install it with: agentio daemon install');
        } else {
          console.log('The agentio daemon is installed but not running.');
          console.log('Start it with: agentio daemon start');
        }
      }
    } catch (e) {
      handleError(e);
    }
  });
```

Add imports for `loadConfig`, `saveConfig`, `homedir`, `join` if not already present.

- [ ] **Step 6: Smoke test**

```bash
mkdir -p /tmp/watchtest
bun run dev schedule watch /tmp/watchtest
```

Expected: "Watching /tmp/watchtest (pinned to <hostname>)." and a message about the daemon install state.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(schedule): add `schedule watch` command"
```

---

## Task 20: `schedule unwatch <folder>` and `schedule watched` commands

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Implement `unwatch`**

In `src/commands/schedule.ts`, inside `registerScheduleCommands`, add:

```ts
schedule.command('unwatch').description('Stop watching a folder')
  .argument('<folder>', 'Folder to remove')
  .action(async (folder: string) => {
    try {
      const absPath = resolve(folder);
      const config = await loadConfig();
      const updated = removeWatchedFolder(config, absPath);
      await saveConfig(updated);

      // Best-effort reload
      const apiKey = updated.daemon?.apiKey;
      const port = updated.daemon?.server?.port ?? 7890;
      if (apiKey) {
        try {
          await fetch(`http://127.0.0.1:${port}/scheduler/reload`, {
            method: 'POST',
            headers: { 'X-API-Key': apiKey },
            signal: AbortSignal.timeout(1500),
          });
        } catch { /* ignore */ }
      }

      console.log(`Unwatched ${abbrHome(absPath)}.`);
    } catch (e) {
      handleError(e);
    }
  });
```

- [ ] **Step 2: Implement `watched`**

```ts
schedule.command('watched').description('List watched folders')
  .action(async () => {
    try {
      const config = await loadConfig();
      const folders = config.daemon?.scheduler?.watchedFolders ?? [];
      if (folders.length === 0) {
        console.log('No folders watched.');
        console.log('Add one with: agentio schedule watch <folder>');
        return;
      }
      for (const f of folders) {
        const pin = f.host ? ` (pinned to ${f.host})` : '';
        console.log(`${abbrHome(f.path)}${pin}`);
      }
    } catch (e) {
      handleError(e);
    }
  });
```

- [ ] **Step 3: Smoke test**

```bash
bun run dev schedule watched
bun run dev schedule unwatch /tmp/watchtest
bun run dev schedule watched
```

Expected: watched list shrinks.

- [ ] **Step 4: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): add `schedule unwatch` and `schedule watched`"
```

---

## Task 21: Remove plist side-effects from `schedule add` / `sync` / `remove`

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Strip the plist calls in `add`**

Edit `src/commands/schedule.ts`. In the `add` command action, find:

```ts
if (hostMatches(finalConfig)) {
  installPlist(folder, id, finalConfig);
} else {
  uninstallPlist(folder, id);
}
```

Remove it entirely. Replace `printSaveResult(filePath, finalConfig);` with a new summary that reflects the new model:

```ts
console.log(`Saved ${abbrHome(filePath)}.`);
console.log(`  schedule: ${describeSchedule(finalConfig.schedule)}`);
console.log(`  enabled:  ${finalConfig.enabled ? 'yes' : 'no'}`);
if (finalConfig.host) console.log(`  host:     ${finalConfig.host}`);

// Hint: is this folder already watched?
const cfg = await loadConfig();
const watched = cfg.daemon?.scheduler?.watchedFolders ?? [];
if (!watched.find((w) => w.path === folder)) {
  console.log(`\nTo have the daemon fire this schedule, run:`);
  console.log(`  agentio schedule watch ${abbrHome(folder)}`);
}
```

Delete `printSaveResult` (it had logic tied to plist installs; now redundant).

- [ ] **Step 2: Strip the plist reconciliation from `sync`**

In the `sync` action, remove everything from the `// 5. Diff against installed plists` block through to the end of that action. What remains in `sync`:

1. Walk for `.run.md` files
2. Collision check
3. Scaffold `.agentio/.gitignore`
4. Fill in missing frontmatter (interactive prompt)

End the action with:

```ts
console.log(`Sync complete: ${desired.size} schedule(s) checked.`);

const cfg = await loadConfig();
const watched = cfg.daemon?.scheduler?.watchedFolders ?? [];
if (!watched.find((w) => w.path === folder)) {
  console.log(`\nThis folder is not watched. Run:`);
  console.log(`  agentio schedule watch ${abbrHome(folder)}`);
}
```

Delete imports that are now unused: `installPlist`, `uninstallPlist`, `enumerateInstalledSchedules`, `folderHash`, `buildPlistDict` — confirm with `bun run typecheck`.

- [ ] **Step 3: Strip the plist call from `remove`**

In the `remove` action, find:

```ts
uninstallPlist(folder, id);
```

Remove both occurrences (one in the `if (matches.length === 0)` branch and one after `unlink`).

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: Errors about unused imports — remove them.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: Some tests will fail (plist-related tests in `schedule.test.ts`). Fix or delete those specific tests. Keep tests that cover non-plist behavior (frontmatter writing, collision detection, etc.).

- [ ] **Step 6: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): remove plist side-effects from add/sync/remove"
```

---

## Task 22: Delete legacy launchd files and their tests

**Files:**
- Delete: `src/services/schedule/launchd.ts`, `launchd.test.ts`, `plist-builder.ts`, `plist-builder.test.ts`, `folder-hash.ts`, `folder-hash.test.ts`

- [ ] **Step 1: Remove the files**

```bash
git rm src/services/schedule/launchd.ts
git rm src/services/schedule/launchd.test.ts
git rm src/services/schedule/plist-builder.ts
git rm src/services/schedule/plist-builder.test.ts
git rm src/services/schedule/folder-hash.ts
git rm src/services/schedule/folder-hash.test.ts
```

- [ ] **Step 2: Verify no remaining imports**

```bash
rg -l "services/schedule/(launchd|plist-builder|folder-hash)" src
```

Expected: no results.

- [ ] **Step 3: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(schedule): delete legacy launchd/plist modules"
```

---

## Task 23: `schedule migrate` command

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Implement the command**

Edit `src/commands/schedule.ts`. Add:

```ts
schedule.command('migrate').description('Remove legacy per-schedule launchd plists and add their folders to the daemon watch list')
  .action(async () => {
    try {
      if (process.platform !== 'darwin') {
        console.log('`schedule migrate` only applies on macOS.');
        return;
      }
      const dir = join(homedir(), 'Library', 'LaunchAgents');
      if (!existsSync(dir)) {
        console.log('Nothing to migrate.');
        return;
      }
      const entries = (await import('fs')).readdirSync(dir)
        .filter((f) => f.startsWith('me.agentio.schedule.') && f.endsWith('.plist'));
      if (entries.length === 0) {
        console.log('Nothing to migrate.');
        return;
      }
      const folders = new Set<string>();
      for (const file of entries) {
        const full = join(dir, file);
        try {
          const raw = (await import('fs')).readFileSync(full, 'utf-8');
          const parsed = (await import('plist')).default.parse(raw) as Record<string, unknown>;
          const args = parsed.ProgramArguments as string[] | undefined;
          // args: [<binary>, "schedule", "run", "<id>", "--folder", "<folder>", "-q"]
          if (args) {
            const fi = args.indexOf('--folder');
            if (fi !== -1 && args[fi + 1]) folders.add(args[fi + 1]);
          }
          // Unload and remove
          (await import('child_process')).execFileSync('/bin/launchctl', ['unload', full], { stdio: 'ignore' });
          (await import('fs')).unlinkSync(full);
        } catch { /* continue */ }
      }

      // Add each distinct folder to the watch list, pinned to current host
      let config = await loadConfig();
      const host = getCurrentHost();
      for (const f of folders) {
        config = addWatchedFolder(config, f, host, Date.now());
      }
      await saveConfig(config);

      console.log(`Migrated ${entries.length} schedule(s) across ${folders.size} folder(s).`);
      console.log('Folders added to watch list:');
      for (const f of folders) console.log(`  ${abbrHome(f)}`);
      console.log('\nIf the daemon is not installed yet, run: agentio daemon install');
    } catch (e) {
      handleError(e);
    }
  });
```

- [ ] **Step 2: Smoke test on a clean machine (no legacy plists)**

```bash
bun run dev schedule migrate
```

Expected: "Nothing to migrate."

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "feat(schedule): add `schedule migrate` command for legacy plists"
```

---

## Task 24: Delegate `schedule list` to daemon API when running

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Update the `list` action**

Replace the existing body of `schedule.command('list')` with:

```ts
.action(async (opts: { folder?: string }) => {
  try {
    const config = await loadConfig();
    const apiKey = config.daemon?.apiKey;
    const port = config.daemon?.server?.port ?? 7890;

    // Try daemon first
    if (apiKey) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/scheduler/list`, {
          headers: { 'X-API-Key': apiKey },
          signal: AbortSignal.timeout(1500),
        });
        if (res.ok) {
          const { jobs } = await res.json() as { jobs: SchedulerJobView[] };
          renderJobs(jobs, opts.folder);
          return;
        }
      } catch { /* fall through to FS mode */ }
    }

    // Daemon not up: read watched folders from config, walk them ourselves
    const folders = config.daemon?.scheduler?.watchedFolders ?? [];
    if (folders.length === 0) {
      console.log('No folders watched.');
      console.log('Add one with: agentio schedule watch <folder>');
      return;
    }
    const now = new Date();
    const host = getCurrentHost();
    const jobs = scanWatchedFolders(folders, host, now).map((j) => ({
      folder: j.folder,
      id: j.id,
      schedule: describeSchedule(j.config.schedule),
      enabled: j.config.enabled,
      nextRun: j.nextRun.toISOString(),
      isRunning: false,
    }));
    renderJobs(jobs, opts.folder);
    console.log('\n(daemon not running — showing filesystem view)');
  } catch (e) {
    handleError(e);
  }
});
```

Add a local `renderJobs` helper above the `registerScheduleCommands` function:

```ts
function renderJobs(jobs: Array<{
  folder: string; id: string; schedule: string;
  enabled: boolean; nextRun: string; isRunning?: boolean;
}>, filterFolder?: string): void {
  const filtered = filterFolder
    ? jobs.filter((j) => j.folder === resolve(filterFolder))
    : jobs;
  if (filtered.length === 0) { console.log('No schedules.'); return; }
  const widths = {
    id: Math.max('ID'.length, ...filtered.map((r) => r.id.length)),
    folder: Math.max('FOLDER'.length, ...filtered.map((r) => abbrHome(r.folder).length)),
    sched: Math.max('SCHEDULE'.length, ...filtered.map((r) => r.schedule.length)),
  };
  console.log(`${'ID'.padEnd(widths.id)}  ${'FOLDER'.padEnd(widths.folder)}  ${'SCHEDULE'.padEnd(widths.sched)}  NEXT`);
  for (const r of filtered) {
    const run = r.isRunning ? ' [running]' : '';
    console.log(`${r.id.padEnd(widths.id)}  ${abbrHome(r.folder).padEnd(widths.folder)}  ${r.schedule.padEnd(widths.sched)}  ${r.nextRun}${run}`);
  }
}
```

Import `scanWatchedFolders` and `SchedulerJobView`:

```ts
import { scanWatchedFolders } from '../daemon/scheduler-core';
import type { SchedulerJobView } from '../daemon/scheduler';
```

- [ ] **Step 2: Smoke test (daemon not running)**

```bash
bun run dev schedule watched
bun run dev schedule list
```

Expected: either shows filesystem view with "(daemon not running)" footer, or "No folders watched."

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): `schedule list` delegates to daemon when running"
```

---

## Task 25: Delegate `schedule run` to daemon API when running

**Files:**
- Modify: `src/commands/schedule.ts`

- [ ] **Step 1: Update the `run` action**

Replace the existing body of `schedule.command('run')` action:

```ts
.action(async (id: string, opts: { folder?: string; quiet?: boolean }) => {
  try {
    const folder = opts.folder ? resolve(opts.folder) : process.cwd();
    const config = await loadConfig();
    const apiKey = config.daemon?.apiKey;
    const port = config.daemon?.server?.port ?? 7890;

    // Try daemon delegation
    if (apiKey) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/scheduler/run`, {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ folder, id }),
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          const result = await res.json() as { started: boolean; reason?: string };
          if (result.started) {
            console.log(`Run queued via daemon. Tail logs in ${folder}/.agentio/runs/${id}/`);
            return;
          }
          console.error(`Daemon refused: ${result.reason}`);
          process.exit(1);
        }
      } catch { /* daemon not up — fall through */ }
    }

    // Local fallback
    const matches = walkRunFiles(folder).filter((f) => f.id === id);
    if (matches.length !== 1) {
      throw new CliError('NOT_FOUND', `No unique .run.md file for id "${id}" under ${folder}`);
    }
    const raw = await readFile(matches[0].path, 'utf-8');
    const parsed = parseFrontmatter(raw);
    const cfg = mergeConfig({}, parsed.config);
    const { exitCode, logPath } = await runSchedule({
      folder, id, promptBody: parsed.body, config: cfg, quiet: opts.quiet ?? false,
    });
    if (!opts.quiet) console.log(`Run complete. Log: ${logPath}`);
    process.exit(exitCode);
  } catch (e) {
    handleError(e);
  }
});
```

- [ ] **Step 2: Typecheck and test**

Run: `bun run typecheck && bun test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/schedule.ts
git commit -m "refactor(schedule): `schedule run` delegates to daemon when running"
```

---

## Task 26: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the "Gateway" section with "Daemon"**

Open `CLAUDE.md`. Find the `### Gateway` section. Replace its body with:

```markdown
### Daemon

The daemon is a long-lived background process that (1) maintains messaging connections (WhatsApp, Telegram) and (2) fires scheduled `.run.md` prompts in watched folders.

```bash
agentio daemon install           # macOS: LaunchAgent; Linux: systemd unit
agentio daemon start [--foreground]
agentio daemon stop
agentio daemon restart
agentio daemon status
agentio daemon logs [--follow]
agentio daemon uninstall
agentio daemon profile add|list|remove    # Remote daemon identity
agentio daemon teleport <url>             # Transfer auth state to remote daemon
```

The macOS LaunchAgent lives at `~/Library/LaunchAgents/me.agentio.daemon.plist` and runs as a user agent (no sudo).
```

- [ ] **Step 2: Update the Schedule section**

Find the `### Schedule` section (or equivalent). Replace the plist-oriented description with:

```markdown
### Schedule

`.run.md` files contain frontmatter describing when to fire. The daemon watches folders registered via `schedule watch` and fires due schedules on a 60-second tick.

```bash
agentio schedule add <file> [options]        # Writes frontmatter into the file
agentio schedule edit <id>
agentio schedule remove <id>
agentio schedule sync [--folder <path>]      # Fill in missing frontmatter
agentio schedule list
agentio schedule show <id>
agentio schedule run <id>                    # Fires now (via daemon if running)
agentio schedule runs <id>
agentio schedule watch <folder>              # Register folder with the daemon
agentio schedule unwatch <folder>
agentio schedule watched                     # List watched folders
agentio schedule migrate                     # One-shot: clean up legacy per-schedule plists
```
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for daemon/scheduler unification"
```

---

## Task 27: CHANGELOG entry and final verification

**Files:**
- Modify: `CHANGELOG.md` (if it exists) or `package.json` version only
- Verify: full `bun run typecheck && bun test`

- [ ] **Step 1: Check for an existing CHANGELOG**

```bash
ls CHANGELOG.md 2>/dev/null
```

If it exists, add an entry. If not, skip to step 2.

If it exists, prepend:

```markdown
## Unreleased

### Breaking
- Renamed `agentio gateway` command tree to `agentio daemon`. The `gateway` alias still works but prints a deprecation warning.
- Renamed `config.gateway` to `config.daemon`; existing configs are migrated on first load.
- Renamed runtime files: `gateway.db` → `daemon.db`, `gateway.log` → `daemon.log`. Existing files are renamed on first daemon start.
- Removed per-schedule launchd plists. Use `agentio schedule migrate` to clean up legacy installs and add their folders to the daemon's watch list.

### Added
- `agentio daemon install` on macOS creates a user LaunchAgent (no sudo required).
- `agentio schedule watch <folder>` / `unwatch <folder>` / `watched` for folder-level scheduling via the daemon.
- `agentio schedule migrate` to clean up legacy per-schedule plists.
- In-daemon scheduler ticks every 60 seconds; one-fire catch-up on startup for schedules that missed their last expected run.
```

- [ ] **Step 2: Final verification**

Run:
```bash
bun run typecheck
bun test
bun run dev daemon --help
bun run dev schedule --help
bun run dev gateway --help   # should print deprecation warning
```

Expected: all pass; help output shows the expected command tree.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: changelog entry for daemon/scheduler unification"
```

---

## Spec Coverage Self-Review

**Spec requirement → Task(s) that implement it:**

| Spec section | Task(s) |
|---|---|
| 1. Rename `gateway` → `daemon` | Tasks 1–7, 12 |
| 2. macOS installer for the daemon | Tasks 8–11 |
| 3. Scheduler inside the daemon | Tasks 13–15 |
| 4. `schedule watch` command | Tasks 19, 20 |
| 5. Retire launchd-per-schedule | Tasks 21, 22 |
| 6. Migration: `schedule migrate` | Task 23 |
| 7. HTTP API additions | Tasks 16, 17, 18 |
| 8. `schedule list` behavior | Task 24 |
| 9. `schedule run` behavior | Task 25 |
| Tests | Tasks 1, 2, 7, 9, 13, 14, 19 (key pure-function and integration tests) |
| Rollout (back-compat, deprecation warning, config migration) | Tasks 2, 6, 7, 12 |
| Docs (CLAUDE.md, CHANGELOG) | Tasks 26, 27 |

All spec requirements are covered.

**Notable implementation details held firm across tasks:**
- `ScheduledJob` shape defined in Task 13 is used unchanged in Tasks 14, 17, 18.
- `SchedulerJobView` defined in Task 17 is imported by Task 24.
- `WatchedFolder` defined in Task 1 is used in Tasks 13, 14, 19, 20, 23.
- `DaemonConfig` defined in Task 1 is used in Task 15 (daemon startup wiring) and Tasks 19–25 (command-level config reads).
