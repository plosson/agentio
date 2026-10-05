import { beforeEach } from 'bun:test';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';

export interface SeedProfile {
  readOnly?: boolean;
  values?: Record<string, string>;
}

let vault: ReturnType<typeof withTempVault>;

/** A temp vault holding these secrets profiles, fresh for every test. Call at module level inside a describe. */
export function withSecretsProfiles(profiles: () => Record<string, SeedProfile>): void {
  const own = withTempVault('agentio-secrets-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { secrets: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: { secrets: Object.fromEntries(entries.map(([name, p]) => [name, { values: p.values ?? {} }])) } as never,
    };
  });
  beforeEach(() => { vault = own; });
}

/** The CLI as an agent runs it, in its own process. `input` is piped on stdin; without it stdin is empty. */
export async function cli(args: string[], input?: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...vault.env(), NO_COLOR: '1', ...env },
  });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

/** The encrypted vault file, to prove a refused write changed nothing. */
export function vaultBytes(): Promise<string> {
  return Bun.file(join(vault.home(), '.config', 'agentio', 'vault.enc')).text();
}
