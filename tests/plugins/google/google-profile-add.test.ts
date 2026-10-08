import { describe, expect, test } from 'bun:test';
import { dirname } from 'path';
import { withTempVault } from '../../helpers/vault';
import { spawnCli } from '../../helpers/cli';
import { SCOPES, type OAuthService } from '../../../src/plugins/google/oauth';

const vault = withTempVault('agentio-google-add-', () => ({ config: { profiles: {} } as never }));

// The seven services whose whole setup is a browser sign-in to Google.
const SERVICES: OAuthService[] = ['gmail', 'gcal', 'gtasks', 'gdocs', 'gsheets', 'gslides', 'gscript'];

// Sequential on purpose: each run listens on the same callback port range.
describe.each(SERVICES)('%s profile add', (service) => {
  test('prints the Google address to open for this service, opens no browser, and listens for the callback', async () => {
    // Only bun on PATH: no browser opener can be found, so the address is printed instead.
    const run = spawnCli([service, 'profile', 'add'], { ...vault.env(), PATH: dirname(process.execPath) });
    const url = new URL((await run.printed(/visit:\n(\S+)/))[1]);
    expect(url.host).toBe('accounts.google.com');
    const scope = url.searchParams.get('scope') ?? '';
    for (const wanted of SCOPES[service]) expect(scope).toContain(wanted);
    const redirect = url.searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/localhost:30(0\d|10)\/callback$/);
    // The callback server is already listening.
    expect((await fetch(`${redirect}?error=access_denied`)).status).toBe(200);
    const res = await run.finish();
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('No browser could be opened on this machine.');
    expect(res.stderr).toMatch(/Error \[AUTH_FAILED\]: .*access_denied/);
    expect(res.stderr).toMatch(/\nSuggestion: \S/);
    expect(res.stdout).not.toContain('configured');
  }, 20_000);
});
