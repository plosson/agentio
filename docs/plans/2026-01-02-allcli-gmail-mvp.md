# AllCLI Gmail MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a CLI tool (`allcli`) that enables programmatic Gmail access with multi-profile OAuth support.

**Architecture:** Commander.js CLI with modular command structure. OAuth tokens stored in encrypted file. Gmail API accessed via googleapis library. JSON output for success, human-readable stderr for errors.

**Tech Stack:** Bun, TypeScript, Commander.js, googleapis, crypto (Node built-in for encryption)

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`

**Step 1: Initialize Bun project**

```bash
cd /Users/plosson/devel/projects/personal/acli
bun init -y
```

**Step 2: Install dependencies**

```bash
bun add commander googleapis
bun add -d @types/node typescript
```

**Step 3: Configure TypeScript**

Replace `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "resolveJsonModule": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: Create CLI entry point**

Create `src/index.ts`:

```typescript
#!/usr/bin/env bun
import { Command } from 'commander';

const program = new Command();

program
  .name('allcli')
  .description('Unified communication CLI')
  .version('0.1.0');

program.parse();
```

**Step 5: Update package.json scripts and bin**

Add to `package.json`:
```json
{
  "bin": {
    "allcli": "./src/index.ts"
  },
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target node",
    "typecheck": "tsc --noEmit"
  }
}
```

**Step 6: Test CLI runs**

```bash
bun run dev --help
```

Expected: Shows help with "Unified communication CLI"

**Step 7: Commit**

```bash
git init
echo "node_modules/\ndist/\n.env" > .gitignore
git add .
git commit -m "feat: initialize allcli project with Commander.js"
```

---

## Task 2: Configuration Manager

**Files:**
- Create: `src/config/config-manager.ts`
- Create: `src/types/config.ts`

**Step 1: Create config types**

Create `src/types/config.ts`:

```typescript
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // Optional, will use dynamic port
}

export interface ServiceProfiles {
  [profileName: string]: OAuthClientConfig;
}

export interface Config {
  profiles: {
    gmail?: ServiceProfiles;
    gchat?: ServiceProfiles;
    jira?: ServiceProfiles;
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    jira?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira';
```

**Step 2: Create config manager**

Create `src/config/config-manager.ts`:

```typescript
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { Config, ServiceName, OAuthClientConfig } from '../types/config';

const CONFIG_DIR = join(homedir(), '.config', 'allcli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Config = {
  profiles: {},
  defaults: {},
};

export async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(): Promise<Config> {
  await ensureConfigDir();

  if (!existsSync(CONFIG_FILE)) {
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  const content = await readFile(CONFIG_FILE, 'utf-8');
  return JSON.parse(content) as Config;
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function getProfile(
  service: ServiceName,
  profileName?: string
): Promise<{ name: string; config: OAuthClientConfig } | null> {
  const config = await loadConfig();
  const name = profileName || config.defaults[service];

  if (!name) {
    return null;
  }

  const serviceProfiles = config.profiles[service];
  if (!serviceProfiles || !serviceProfiles[name]) {
    return null;
  }

  return { name, config: serviceProfiles[name] };
}

export async function setProfile(
  service: ServiceName,
  profileName: string,
  oauthConfig: OAuthClientConfig
): Promise<void> {
  const config = await loadConfig();

  if (!config.profiles[service]) {
    config.profiles[service] = {};
  }

  config.profiles[service]![profileName] = oauthConfig;

  // Set as default if it's the first profile for this service
  if (!config.defaults[service]) {
    config.defaults[service] = profileName;
  }

  await saveConfig(config);
}

export async function removeProfile(
  service: ServiceName,
  profileName: string
): Promise<boolean> {
  const config = await loadConfig();

  const serviceProfiles = config.profiles[service];
  if (!serviceProfiles || !serviceProfiles[profileName]) {
    return false;
  }

  delete serviceProfiles[profileName];

  // Clear default if it was the removed profile
  if (config.defaults[service] === profileName) {
    const remaining = Object.keys(serviceProfiles);
    config.defaults[service] = remaining[0];
  }

  await saveConfig(config);
  return true;
}

export async function listProfiles(service?: ServiceName): Promise<{
  service: ServiceName;
  profiles: string[];
  default?: string;
}[]> {
  const config = await loadConfig();
  const services: ServiceName[] = service ? [service] : ['gmail', 'gchat', 'jira'];

  return services.map((svc) => ({
    service: svc,
    profiles: Object.keys(config.profiles[svc] || {}),
    default: config.defaults[svc],
  }));
}

export { CONFIG_DIR, CONFIG_FILE };
```

**Step 3: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add configuration manager for profiles"
```

---

## Task 3: Token Storage (Encrypted)

**Files:**
- Create: `src/auth/token-store.ts`
- Create: `src/types/tokens.ts`

**Step 1: Create token types**

Create `src/types/tokens.ts`:

```typescript
export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope?: string;
}

export interface StoredTokens {
  [service: string]: {
    [profile: string]: OAuthTokens;
  };
}
```

**Step 2: Create encrypted token store**

Create `src/auth/token-store.ts`:

```typescript
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { hostname, userInfo } from 'os';
import { CONFIG_DIR, ensureConfigDir } from '../config/config-manager';
import type { OAuthTokens, StoredTokens } from '../types/tokens';
import type { ServiceName } from '../types/config';

const TOKENS_FILE = join(CONFIG_DIR, 'tokens.enc');
const ALGORITHM = 'aes-256-gcm';

// Derive a machine-specific key from hostname + username
function deriveKey(): Buffer {
  const machineId = `${hostname()}-${userInfo().username}-allcli-v1`;
  return scryptSync(machineId, 'allcli-salt', 32);
}

async function loadTokens(): Promise<StoredTokens> {
  await ensureConfigDir();

  if (!existsSync(TOKENS_FILE)) {
    return {};
  }

  const encrypted = await readFile(TOKENS_FILE, 'utf-8');
  const { iv, tag, data } = JSON.parse(encrypted);

  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf-8'));
}

async function saveTokens(tokens: StoredTokens): Promise<void> {
  await ensureConfigDir();

  const key = deriveKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const data = JSON.stringify(tokens);
  const encrypted = Buffer.concat([
    cipher.update(data, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  const stored = JSON.stringify({
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  });

  await writeFile(TOKENS_FILE, stored, { mode: 0o600 });
}

export async function getTokens(
  service: ServiceName,
  profile: string
): Promise<OAuthTokens | null> {
  const tokens = await loadTokens();
  return tokens[service]?.[profile] || null;
}

export async function setTokens(
  service: ServiceName,
  profile: string,
  oauthTokens: OAuthTokens
): Promise<void> {
  const tokens = await loadTokens();

  if (!tokens[service]) {
    tokens[service] = {};
  }

  tokens[service][profile] = oauthTokens;
  await saveTokens(tokens);
}

export async function removeTokens(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const tokens = await loadTokens();

  if (!tokens[service]?.[profile]) {
    return false;
  }

  delete tokens[service][profile];
  await saveTokens(tokens);
  return true;
}

export async function hasTokens(
  service: ServiceName,
  profile: string
): Promise<boolean> {
  const tokens = await loadTokens();
  return !!tokens[service]?.[profile];
}
```

**Step 3: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add encrypted token storage"
```

---

## Task 4: Output Utilities

**Files:**
- Create: `src/utils/output.ts`
- Create: `src/utils/errors.ts`

**Step 1: Create JSON output formatter**

Create `src/utils/output.ts`:

```typescript
import type { ServiceName } from '../types/config';

export interface SuccessResponse<T = unknown> {
  success: true;
  service: ServiceName;
  command: string;
  profile: string;
  data: T;
  timestamp: string;
}

export function success<T>(
  service: ServiceName,
  command: string,
  profile: string,
  data: T
): void {
  const response: SuccessResponse<T> = {
    success: true,
    service,
    command,
    profile,
    data,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(response, null, 2));
}
```

**Step 2: Create error handler**

Create `src/utils/errors.ts`:

```typescript
export type ErrorCode =
  | 'AUTH_FAILED'
  | 'TOKEN_EXPIRED'
  | 'PROFILE_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFIG_ERROR';

export class CliError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public suggestion?: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export function exitCodeForError(code: ErrorCode): number {
  switch (code) {
    case 'AUTH_FAILED':
    case 'TOKEN_EXPIRED':
    case 'PERMISSION_DENIED':
      return 2;
    case 'CONFIG_ERROR':
    case 'PROFILE_NOT_FOUND':
      return 3;
    case 'NETWORK_ERROR':
      return 4;
    case 'API_ERROR':
    case 'RATE_LIMITED':
    case 'NOT_FOUND':
      return 5;
    default:
      return 1;
  }
}

export function handleError(error: unknown): never {
  if (error instanceof CliError) {
    console.error(`Error [${error.code}]: ${error.message}`);
    if (error.suggestion) {
      console.error(`Suggestion: ${error.suggestion}`);
    }
    process.exit(exitCodeForError(error.code));
  }

  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }

  console.error('An unexpected error occurred');
  process.exit(1);
}
```

**Step 3: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add output utilities and error handling"
```

---

## Task 5: OAuth Flow with Dynamic Port

**Files:**
- Create: `src/auth/oauth.ts`

**Step 1: Create OAuth flow handler**

Create `src/auth/oauth.ts`:

```typescript
import { createServer, type Server } from 'http';
import { URL } from 'url';
import { google } from 'googleapis';
import type { OAuthClientConfig } from '../types/config';
import type { OAuthTokens } from '../types/tokens';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
];

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3010;

async function findAvailablePort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.listen(port, () => {
          server.close(() => resolve());
        });
        server.on('error', reject);
      });
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`No available port found in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

export async function performOAuthFlow(
  config: OAuthClientConfig,
  service: 'gmail' | 'gchat'
): Promise<OAuthTokens> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;

  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret,
    redirectUri
  );

  const scopes = service === 'gmail' ? GMAIL_SCOPES : [];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  return new Promise((resolve, reject) => {
    let server: Server;

    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth flow timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing authorization code');
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>');

        clearTimeout(timeout);
        server.close();

        resolve({
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token || undefined,
          expiry_date: tokens.expiry_date || undefined,
          token_type: tokens.token_type || 'Bearer',
          scope: tokens.scope || undefined,
        });
      } catch (err) {
        res.writeHead(500);
        res.end('Failed to exchange authorization code');
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.error(`\nOpening browser for authorization...`);
      console.error(`If browser doesn't open, visit:\n${authUrl}\n`);

      // Open browser
      const open = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' : 'xdg-open';
      Bun.spawn([open, authUrl], { stdout: 'ignore', stderr: 'ignore' });
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
```

**Step 2: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add OAuth flow with dynamic port selection"
```

---

## Task 6: Token Manager (Refresh Logic)

**Files:**
- Create: `src/auth/token-manager.ts`

**Step 1: Create token manager**

Create `src/auth/token-manager.ts`:

```typescript
import { google } from 'googleapis';
import { getTokens, setTokens } from './token-store';
import { getProfile } from '../config/config-manager';
import { CliError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export async function getValidTokens(
  service: ServiceName,
  profileName?: string
): Promise<{ tokens: OAuthTokens; profile: string }> {
  const profile = await getProfile(service, profileName);

  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      profileName
        ? `Profile "${profileName}" not found for ${service}`
        : `No default profile configured for ${service}`,
      `Run: allcli auth setup ${service} --profile <name>`
    );
  }

  const tokens = await getTokens(service, profile.name);

  if (!tokens) {
    throw new CliError(
      'AUTH_FAILED',
      `No tokens found for ${service} profile "${profile.name}"`,
      `Run: allcli auth setup ${service} --profile ${profile.name}`
    );
  }

  // Check if token needs refresh
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - TOKEN_EXPIRY_BUFFER_MS) {
    if (!tokens.refresh_token) {
      throw new CliError(
        'TOKEN_EXPIRED',
        'Access token expired and no refresh token available',
        `Run: allcli auth setup ${service} --profile ${profile.name}`
      );
    }

    const refreshed = await refreshTokens(service, profile.name, profile.config, tokens);
    return { tokens: refreshed, profile: profile.name };
  }

  return { tokens, profile: profile.name };
}

async function refreshTokens(
  service: ServiceName,
  profileName: string,
  config: { clientId: string; clientSecret: string },
  tokens: OAuthTokens
): Promise<OAuthTokens> {
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret
  );

  oauth2Client.setCredentials({
    refresh_token: tokens.refresh_token,
  });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    const newTokens: OAuthTokens = {
      access_token: credentials.access_token!,
      refresh_token: credentials.refresh_token || tokens.refresh_token,
      expiry_date: credentials.expiry_date || undefined,
      token_type: credentials.token_type || 'Bearer',
      scope: credentials.scope || tokens.scope,
    };

    await setTokens(service, profileName, newTokens);
    return newTokens;
  } catch (error) {
    throw new CliError(
      'TOKEN_EXPIRED',
      'Failed to refresh access token',
      `Run: allcli auth setup ${service} --profile ${profileName}`
    );
  }
}

export function createGoogleAuth(tokens: OAuthTokens, config: { clientId: string; clientSecret: string }) {
  const oauth2Client = new google.auth.OAuth2(
    config.clientId,
    config.clientSecret
  );

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  });

  return oauth2Client;
}
```

**Step 2: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add token manager with automatic refresh"
```

---

## Task 7: Auth Commands

**Files:**
- Create: `src/commands/auth.ts`
- Modify: `src/index.ts`

**Step 1: Create auth commands**

Create `src/commands/auth.ts`:

```typescript
import { Command } from 'commander';
import { setProfile, removeProfile, listProfiles, getProfile } from '../config/config-manager';
import { setTokens, removeTokens, hasTokens } from '../auth/token-store';
import { performOAuthFlow } from '../auth/oauth';
import { getValidTokens } from '../auth/token-manager';
import { CliError, handleError } from '../utils/errors';
import type { ServiceName } from '../types/config';

const VALID_SERVICES: ServiceName[] = ['gmail', 'gchat', 'jira'];

function validateService(service: string): ServiceName {
  if (!VALID_SERVICES.includes(service as ServiceName)) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid service: ${service}`,
      `Valid services: ${VALID_SERVICES.join(', ')}`
    );
  }
  return service as ServiceName;
}

export function registerAuthCommands(program: Command): void {
  const auth = program
    .command('auth')
    .description('Manage authentication');

  auth
    .command('setup <service>')
    .description('Set up authentication for a service')
    .requiredOption('--profile <name>', 'Profile name')
    .requiredOption('--client-id <id>', 'OAuth client ID')
    .requiredOption('--client-secret <secret>', 'OAuth client secret')
    .action(async (service: string, options) => {
      try {
        const svc = validateService(service);
        const { profile, clientId, clientSecret } = options;

        if (svc === 'jira') {
          throw new CliError('INVALID_PARAMS', 'Jira is not yet supported');
        }

        // Save profile config
        await setProfile(svc, profile, {
          clientId,
          clientSecret,
        });

        console.error(`Starting OAuth flow for ${svc} profile "${profile}"...`);

        // Perform OAuth flow
        const tokens = await performOAuthFlow({ clientId, clientSecret }, svc);

        // Save tokens
        await setTokens(svc, profile, tokens);

        console.error(`\nSuccess! Profile "${profile}" for ${svc} is now configured.`);
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command('list [service]')
    .description('List configured profiles')
    .action(async (service?: string) => {
      try {
        const svc = service ? validateService(service) : undefined;
        const profiles = await listProfiles(svc);

        for (const { service: s, profiles: p, default: d } of profiles) {
          if (p.length === 0) {
            console.log(`${s}: (no profiles)`);
          } else {
            const items = p.map((name) => name === d ? `${name} (default)` : name);
            console.log(`${s}: ${items.join(', ')}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command('remove <service>')
    .description('Remove a profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (service: string, options) => {
      try {
        const svc = validateService(service);
        const { profile } = options;

        const removed = await removeProfile(svc, profile);
        await removeTokens(svc, profile);

        if (removed) {
          console.error(`Removed profile "${profile}" for ${svc}`);
        } else {
          console.error(`Profile "${profile}" not found for ${svc}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  auth
    .command('test <service>')
    .description('Test authentication for a profile')
    .option('--profile <name>', 'Profile name (uses default if not specified)')
    .action(async (service: string, options) => {
      try {
        const svc = validateService(service);

        const { tokens, profile } = await getValidTokens(svc, options.profile);

        console.error(`Authentication successful for ${svc} profile "${profile}"`);
        console.error(`Token expires: ${tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'unknown'}`);
      } catch (error) {
        handleError(error);
      }
    });
}
```

**Step 2: Update index.ts to register auth commands**

Replace `src/index.ts`:

```typescript
#!/usr/bin/env bun
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth';

const program = new Command();

program
  .name('allcli')
  .description('Unified communication CLI')
  .version('0.1.0');

registerAuthCommands(program);

program.parse();
```

**Step 3: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 4: Test auth list command**

```bash
bun run dev auth list
```

Expected: Shows empty profile list

**Step 5: Commit**

```bash
git add .
git commit -m "feat: add auth commands (setup, list, remove, test)"
```

---

## Task 8: Stdin Utility

**Files:**
- Create: `src/utils/stdin.ts`

**Step 1: Create stdin reader**

Create `src/utils/stdin.ts`:

```typescript
export async function readStdin(): Promise<string | null> {
  // Check if stdin is a TTY (interactive terminal)
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  return Buffer.concat(chunks).toString('utf-8').trim();
}
```

**Step 2: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 3: Commit**

```bash
git add .
git commit -m "feat: add stdin utility for reading piped input"
```

---

## Task 9: Gmail API Client

**Files:**
- Create: `src/services/gmail/client.ts`
- Create: `src/types/gmail.ts`

**Step 1: Create Gmail types**

Create `src/types/gmail.ts`:

```typescript
export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  snippet: string;
  labels: string[];
  body?: string;
}

export interface GmailListOptions {
  limit?: number;
  query?: string;
  labels?: string[];
}

export interface GmailSendOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  isHtml?: boolean;
}

export interface GmailReplyOptions {
  threadId: string;
  body: string;
  isHtml?: boolean;
}
```

**Step 2: Create Gmail client**

Create `src/services/gmail/client.ts`:

```typescript
import { google, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { GmailMessage, GmailListOptions, GmailSendOptions, GmailReplyOptions } from '../../types/gmail';
import { CliError } from '../../utils/errors';

export class GmailClient {
  private gmail: gmail_v1.Gmail;
  private userEmail: string | null = null;

  constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  private async getUserEmail(): Promise<string> {
    if (this.userEmail) return this.userEmail;

    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || 'me';
    return this.userEmail;
  }

  private parseHeaders(headers: gmail_v1.Schema$MessagePartHeader[] | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    for (const header of headers || []) {
      if (header.name && header.value) {
        result[header.name.toLowerCase()] = header.value;
      }
    }
    return result;
  }

  private parseMessage(message: gmail_v1.Schema$Message): GmailMessage {
    const headers = this.parseHeaders(message.payload?.headers);

    const parseAddresses = (value?: string): string[] => {
      if (!value) return [];
      return value.split(',').map((addr) => addr.trim());
    };

    return {
      id: message.id!,
      threadId: message.threadId!,
      subject: headers['subject'] || '(no subject)',
      from: headers['from'] || '',
      to: parseAddresses(headers['to']),
      cc: parseAddresses(headers['cc']),
      date: headers['date'] || '',
      snippet: message.snippet || '',
      labels: message.labelIds || [],
    };
  }

  private getBody(payload: gmail_v1.Schema$MessagePart | undefined, preferHtml: boolean = false): string {
    if (!payload) return '';

    const findPart = (part: gmail_v1.Schema$MessagePart, mimeType: string): string | null => {
      if (part.mimeType === mimeType && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      for (const child of part.parts || []) {
        const result = findPart(child, mimeType);
        if (result) return result;
      }
      return null;
    };

    const targetMime = preferHtml ? 'text/html' : 'text/plain';
    const fallbackMime = preferHtml ? 'text/plain' : 'text/html';

    return findPart(payload, targetMime) || findPart(payload, fallbackMime) || '';
  }

  async list(options: GmailListOptions = {}): Promise<{ messages: GmailMessage[]; total: number }> {
    const { limit = 10, query, labels } = options;

    let q = query || '';
    if (labels?.length) {
      q += ' ' + labels.map((l) => `label:${l}`).join(' ');
    }

    try {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        maxResults: Math.min(limit, 100),
        q: q.trim() || undefined,
      });

      const messageIds = response.data.messages || [];
      const messages: GmailMessage[] = [];

      for (const { id } of messageIds) {
        if (!id) continue;
        const msg = await this.gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'],
        });
        messages.push(this.parseMessage(msg.data));
      }

      return {
        messages,
        total: response.data.resultSizeEstimate || messages.length,
      };
    } catch (error: any) {
      throw new CliError('API_ERROR', `Gmail API error: ${error.message}`);
    }
  }

  async get(messageId: string, format: 'text' | 'html' | 'raw' = 'text'): Promise<GmailMessage & { body: string }> {
    try {
      const response = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: format === 'raw' ? 'raw' : 'full',
      });

      const message = this.parseMessage(response.data);
      let body: string;

      if (format === 'raw') {
        body = response.data.raw ? Buffer.from(response.data.raw, 'base64').toString('utf-8') : '';
      } else {
        body = this.getBody(response.data.payload, format === 'html');
      }

      return { ...message, body };
    } catch (error: any) {
      if (error.code === 404) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      throw new CliError('API_ERROR', `Gmail API error: ${error.message}`);
    }
  }

  async search(query: string, limit: number = 10): Promise<{ messages: GmailMessage[]; total: number }> {
    return this.list({ query, limit });
  }

  async send(options: GmailSendOptions): Promise<{ id: string; threadId: string; labelIds: string[] }> {
    const { to, cc, bcc, subject, body, isHtml } = options;
    const userEmail = await this.getUserEmail();

    const headers = [
      `From: ${userEmail}`,
      `To: ${to.join(', ')}`,
      cc?.length ? `Cc: ${cc.join(', ')}` : '',
      bcc?.length ? `Bcc: ${bcc.join(', ')}` : '',
      `Subject: ${subject}`,
      `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
      '',
      body,
    ].filter(Boolean).join('\r\n');

    const encodedMessage = Buffer.from(headers).toString('base64url');

    try {
      const response = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage },
      });

      return {
        id: response.data.id!,
        threadId: response.data.threadId!,
        labelIds: response.data.labelIds || ['SENT'],
      };
    } catch (error: any) {
      throw new CliError('API_ERROR', `Failed to send email: ${error.message}`);
    }
  }

  async reply(options: GmailReplyOptions): Promise<{ id: string; threadId: string; labelIds: string[] }> {
    const { threadId, body, isHtml } = options;

    // Get the thread to find the last message
    try {
      const thread = await this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
      });

      const messages = thread.data.messages || [];
      if (messages.length === 0) {
        throw new CliError('NOT_FOUND', `Thread not found: ${threadId}`);
      }

      const lastMessage = messages[messages.length - 1];
      const headers = this.parseHeaders(lastMessage.payload?.headers);

      const userEmail = await this.getUserEmail();
      const replyTo = headers['reply-to'] || headers['from'] || '';
      const subject = headers['subject']?.startsWith('Re:')
        ? headers['subject']
        : `Re: ${headers['subject'] || '(no subject)'}`;
      const messageId = headers['message-id'] || '';

      const rawHeaders = [
        `From: ${userEmail}`,
        `To: ${replyTo}`,
        `Subject: ${subject}`,
        messageId ? `In-Reply-To: ${messageId}` : '',
        messageId ? `References: ${messageId}` : '',
        `Content-Type: ${isHtml ? 'text/html' : 'text/plain'}; charset=utf-8`,
        '',
        body,
      ].filter(Boolean).join('\r\n');

      const encodedMessage = Buffer.from(rawHeaders).toString('base64url');

      const response = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });

      return {
        id: response.data.id!,
        threadId: response.data.threadId!,
        labelIds: response.data.labelIds || ['SENT'],
      };
    } catch (error: any) {
      if (error instanceof CliError) throw error;
      throw new CliError('API_ERROR', `Failed to send reply: ${error.message}`);
    }
  }

  async archive(messageId: string): Promise<void> {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          removeLabelIds: ['INBOX'],
        },
      });
    } catch (error: any) {
      if (error.code === 404) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      throw new CliError('API_ERROR', `Failed to archive: ${error.message}`);
    }
  }

  async mark(messageId: string, read: boolean): Promise<void> {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: read
          ? { removeLabelIds: ['UNREAD'] }
          : { addLabelIds: ['UNREAD'] },
      });
    } catch (error: any) {
      if (error.code === 404) {
        throw new CliError('NOT_FOUND', `Message not found: ${messageId}`);
      }
      throw new CliError('API_ERROR', `Failed to update message: ${error.message}`);
    }
  }
}
```

**Step 3: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 4: Commit**

```bash
git add .
git commit -m "feat: add Gmail API client with all operations"
```

---

## Task 10: Gmail Commands

**Files:**
- Create: `src/commands/gmail.ts`
- Modify: `src/index.ts`

**Step 1: Create Gmail commands**

Create `src/commands/gmail.ts`:

```typescript
import { Command } from 'commander';
import { getValidTokens, createGoogleAuth } from '../auth/token-manager';
import { getProfile } from '../config/config-manager';
import { GmailClient } from '../services/gmail/client';
import { success } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';

async function getGmailClient(profileName?: string): Promise<{ client: GmailClient; profile: string }> {
  const { tokens, profile } = await getValidTokens('gmail', profileName);
  const profileConfig = await getProfile('gmail', profile);

  if (!profileConfig) {
    throw new CliError('PROFILE_NOT_FOUND', `Profile config not found for "${profile}"`);
  }

  const auth = createGoogleAuth(tokens, profileConfig.config);
  return { client: new GmailClient(auth), profile };
}

export function registerGmailCommands(program: Command): void {
  const gmail = program
    .command('gmail')
    .description('Gmail operations');

  gmail
    .command('list')
    .description('List messages')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Number of messages', '10')
    .option('--query <query>', 'Search query')
    .option('--label <label>', 'Filter by label (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .action(async (options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.list({
          limit: parseInt(options.limit, 10),
          query: options.query,
          labels: options.label.length ? options.label : undefined,
        });
        success('gmail', 'list', profile, result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('get <message-id>')
    .description('Get a message')
    .option('--profile <name>', 'Profile name')
    .option('--format <format>', 'Body format: text, html, or raw', 'text')
    .action(async (messageId: string, options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.get(messageId, options.format);
        success('gmail', 'get', profile, result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('search')
    .description('Search messages')
    .requiredOption('--query <query>', 'Search query')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Max results', '10')
    .action(async (options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.search(options.query, parseInt(options.limit, 10));
        success('gmail', 'search', profile, result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('send')
    .description('Send an email')
    .option('--profile <name>', 'Profile name')
    .requiredOption('--to <email>', 'Recipient (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--cc <email>', 'CC recipient (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .option('--bcc <email>', 'BCC recipient (repeatable)', (val, acc: string[]) => [...acc, val], [])
    .requiredOption('--subject <subject>', 'Email subject')
    .option('--body <body>', 'Email body (or pipe via stdin)')
    .option('--html', 'Treat body as HTML')
    .action(async (options) => {
      try {
        let body = options.body;

        // Check for stdin if no body provided
        if (!body) {
          body = await readStdin();
        }

        if (!body) {
          throw new CliError('INVALID_PARAMS', 'Body is required. Use --body or pipe via stdin.');
        }

        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.send({
          to: options.to,
          cc: options.cc.length ? options.cc : undefined,
          bcc: options.bcc.length ? options.bcc : undefined,
          subject: options.subject,
          body,
          isHtml: options.html,
        });
        success('gmail', 'send', profile, result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('reply')
    .description('Reply to a thread')
    .option('--profile <name>', 'Profile name')
    .requiredOption('--thread-id <id>', 'Thread ID')
    .option('--body <body>', 'Reply body (or pipe via stdin)')
    .option('--html', 'Treat body as HTML')
    .action(async (options) => {
      try {
        let body = options.body;

        if (!body) {
          body = await readStdin();
        }

        if (!body) {
          throw new CliError('INVALID_PARAMS', 'Body is required. Use --body or pipe via stdin.');
        }

        const { client, profile } = await getGmailClient(options.profile);
        const result = await client.reply({
          threadId: options.threadId,
          body,
          isHtml: options.html,
        });
        success('gmail', 'reply', profile, result);
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('archive <message-id>')
    .description('Archive a message')
    .option('--profile <name>', 'Profile name')
    .action(async (messageId: string, options) => {
      try {
        const { client, profile } = await getGmailClient(options.profile);
        await client.archive(messageId);
        success('gmail', 'archive', profile, { messageId, archived: true });
      } catch (error) {
        handleError(error);
      }
    });

  gmail
    .command('mark <message-id>')
    .description('Mark message as read or unread')
    .option('--profile <name>', 'Profile name')
    .option('--read', 'Mark as read')
    .option('--unread', 'Mark as unread')
    .action(async (messageId: string, options) => {
      try {
        if (!options.read && !options.unread) {
          throw new CliError('INVALID_PARAMS', 'Specify --read or --unread');
        }
        if (options.read && options.unread) {
          throw new CliError('INVALID_PARAMS', 'Cannot specify both --read and --unread');
        }

        const { client, profile } = await getGmailClient(options.profile);
        await client.mark(messageId, options.read);
        success('gmail', 'mark', profile, {
          messageId,
          read: options.read,
        });
      } catch (error) {
        handleError(error);
      }
    });
}
```

**Step 2: Update index.ts to register Gmail commands**

Replace `src/index.ts`:

```typescript
#!/usr/bin/env bun
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth';
import { registerGmailCommands } from './commands/gmail';

const program = new Command();

program
  .name('allcli')
  .description('Unified communication CLI')
  .version('0.1.0');

registerAuthCommands(program);
registerGmailCommands(program);

program.parse();
```

**Step 3: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: No errors

**Step 4: Test help output**

```bash
bun run dev gmail --help
```

Expected: Shows all Gmail commands

**Step 5: Commit**

```bash
git add .
git commit -m "feat: add Gmail commands (list, get, search, send, reply, archive, mark)"
```

---

## Task 11: Final Verification

**Step 1: Run full typecheck**

```bash
bun run typecheck
```

Expected: No errors

**Step 2: Verify CLI help**

```bash
bun run dev --help
bun run dev auth --help
bun run dev gmail --help
```

Expected: All commands show correctly

**Step 3: Build the CLI**

```bash
bun run build
```

Expected: Builds successfully to `dist/`

**Step 4: Final commit**

```bash
git add .
git commit -m "chore: complete Gmail MVP implementation"
```

---

## Summary

This plan implements the allcli Gmail MVP with:

1. **Project setup** - Bun + TypeScript + Commander.js
2. **Configuration** - Multi-profile config in `~/.config/allcli/config.json`
3. **Token storage** - Encrypted file at `~/.config/allcli/tokens.enc`
4. **OAuth** - Dynamic port selection (3000-3010), browser-based flow
5. **Auth commands** - setup, list, remove, test
6. **Gmail client** - Full API wrapper for all operations
7. **Gmail commands** - list, get, search, send, reply, archive, mark
8. **Output** - JSON for success, human-readable stderr for errors
9. **Stdin support** - Both `--body` and piped input for send/reply

Total: 11 tasks, ~45 steps
