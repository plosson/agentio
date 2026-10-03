import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ICON_SVG, INDEX_HTML } from '../../../src/daemon/ui/assets';

const UI = join(import.meta.dir, '../../../src/daemon/ui');
const familyCss = readFileSync(join(UI, 'family.css'), 'utf8');
const adminCss = readFileSync(join(UI, 'admin.css'), 'utf8');

const script = INDEX_HTML.slice(INDEX_HTML.indexOf('<script nonce="__CSP_NONCE__">') + '<script nonce="__CSP_NONCE__">'.length, INDEX_HTML.lastIndexOf('</script>'));
const style = INDEX_HTML.slice(INDEX_HTML.indexOf('<style nonce="__CSP_NONCE__">'), INDEX_HTML.indexOf('</style>'));

describe('the assembled admin page', () => {
  test('every build-time placeholder is filled; only the per-request ones remain', () => {
    expect(INDEX_HTML).not.toContain('/*__STYLES__*/');
    expect(INDEX_HTML).not.toContain('//__SCRIPT__');
    expect(INDEX_HTML).toContain('__PLUGIN_METADATA__');
    expect(INDEX_HTML.match(/__CSP_NONCE__/g)).toHaveLength(2);
    expect(INDEX_HTML).toContain('__VERSION__');
  });

  test('one inline script and one inline style; the only link is the favicon, served by the hub', () => {
    expect(INDEX_HTML.match(/<script\b/g)).toHaveLength(1);
    expect(INDEX_HTML.match(/<style\b/g)).toHaveLength(1);
    expect(INDEX_HTML.match(/<link\b[^>]*>/g)).toEqual(['<link rel="icon" href="/ui/icon.svg?v=__VERSION__" type="image/svg+xml">']);
  });

  test('the script is valid JavaScript with no module syntax left', () => {
    expect(() => new Bun.Transpiler({ loader: 'js' }).transformSync(script.replace('__PLUGIN_METADATA__', '{}'))).not.toThrow();
    expect(script).not.toMatch(/^\s*export\s/m);
    expect(script).not.toMatch(/^\s*import\s/m);
    expect(script).not.toMatch(/\binterface\s+\w+\s*\{/);
  });

  test('dollar signs in the source survive assembly', () => {
    expect(script).toContain("const $ = (id) => document.getElementById(id);");
    expect(script).toContain('${');
  });

    test('the header: lockup, text tabs, where you are, Sign out; no bottom tab bar, no gear', () => {
    expect(INDEX_HTML).toContain('<a class="lockup" href="#overview"><img src="/ui/icon.svg?v=__VERSION__" alt="" width="36" height="36">agentio</a>');
    expect(INDEX_HTML).toContain('<nav class="tabs" id="tabs" aria-label="Main">');
    expect(INDEX_HTML).not.toContain('id="tabbar"');
    expect(INDEX_HTML).not.toContain('class="gear"');
    expect(INDEX_HTML).not.toContain('agentio hub');
    expect(INDEX_HTML).toMatch(/<button[^>]*class="button link sign-out"[^>]*data-action="sign-out"/);
    expect(INDEX_HTML).toMatch(/<button[^>]*id="menu-button"[^>]*aria-expanded="false"[^>]*aria-controls="tabs"/);
    expect(INDEX_HTML).toContain('<footer class="version" id="version" hidden></footer>');
    expect(script).toContain("ACTIONS['toggle-menu']");
  });

  test('the browser title follows the H1: "<H1> · agentio"', () => {
    expect(script).toContain('function setTitle(');
    expect(script).toContain("`${h1.textContent.trim()} · agentio`");
  });

  test('layout: one column under 600 px with the menu, 720 px up to 959 px, 1120 px and two columns from 960 px', () => {
    expect(style).toMatch(/@media \(max-width: 599px\)[\s\S]*\.tabs \{[^}]*display: none/);
    expect(style).toMatch(/@media \(min-width: 600px\) and \(max-width: 959px\) \{ \.page \{ max-width: 720px; \} \}/);
    expect(style).toMatch(/\.page \{[^}]*max-width: 1120px/);
    expect(style).toMatch(/@media \(min-width: 960px\) \{[^@]*\.columns \{[^}]*grid-template-columns/);
  });

  test('the model and every screen are in the script', () => {
    for (const name of ['function escapeHtml', 'function parseRoute', 'function toggleScope']) expect(script).toContain(name);
    for (const view of ['machines', 'machine', 'profiles', 'profile', 'add', 'access', 'settings', 'authorize']) {
      expect(script).toMatch(new RegExp(`VIEWS\\.${view} = `));
    }
  });

  test('no inline style attributes, which the CSP would block', () => {
    expect(INDEX_HTML).not.toMatch(/\sstyle\s*=/);
  });

  test('the style is the family tokens, then the agentio brand, then the admin; no web font', () => {
    expect(style).not.toMatch(/@font-face|url\(/);
    expect(style).not.toContain('Balsamiq');
    const family = style.indexOf('--bg: #F8F0E0;');
    const brand = style.indexOf('--brand: #2F5FD8;');
    expect(family).toBeGreaterThan(-1);
    expect(brand).toBeGreaterThan(family);
    expect(style).toContain('--primary-fg: #F8F0E0;');
    expect(style).toContain('--display-fg: #F2C14E;');
  });

  test('admin.css uses roles, never a hex colour', () => {
    expect(adminCss).not.toMatch(/:[^;{}]*#[0-9a-fA-F]{3,8}\b/);
  });

  test("family.css is the brand document's family block, unchanged", () => {
    expect(familyCss).toBe(FAMILY_CSS);
  });

  test('the vault icon: one SVG, no script, no outside reference', () => {
    expect(ICON_SVG.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">')).toBe(true);
    expect(ICON_SVG).not.toMatch(/<script|\son\w+=|href=|<foreignObject/i);
    expect(ICON_SVG).toContain('<g class="dial">');
    expect(ICON_SVG).toContain('class="knob"');
  });

  test('profiles: its actions are registered and its commands come from the model', () => {
    for (const action of ["ACTIONS['test-one']", "ACTIONS['rename-profile']", "ACTIONS['delete-profile']", "ACTIONS['pick-service']"]) {
      expect(script).toContain(action);
    }
    expect(script).toContain('reauthCommand(');
    expect(script).toContain('addCommand(');
  });

  test('machines: its actions are registered', () => {
    for (const name of ["ACTIONS['toggle-connect']", "ACTIONS['rename-machine']", "ACTIONS['replace-key']", "ACTIONS['revoke-machine']",
      "SUBMITS['create-key']", "SUBMITS['save-scope']", "CHANGES['machine-ro']", "CHANGES['machine-manage']"]) {
      expect(script).toContain(name);
    }
    expect(script).toContain('loginCommand(');
    expect(script).toContain('reachableRefs(');
  });

  test('sign-in: three steps, read-only by default, and an ended request is explained', () => {
    for (const name of ["ACTIONS['auth-yes']", "ACTIONS['auth-deny']", "SUBMITS['auth-approve']"]) expect(script).toContain(name);
    expect(script).toContain('This sign-in request has ended or was already answered. Run agentio login again on the machine.');
    expect(script).toMatch(/name="\$\{prefix\}-preset" value="read-all" checked/);
  });

  test('access: cells toggle through toggleScope, never by hand', () => {
    expect(script).toContain("ACTIONS['toggle-cell']");
    expect(script).toContain('toggleScope(');
    expect(script).toContain('accessCell(');
  });

  test('no Overview: waiting sign-ins show as a banner on every page instead', () => {
    expect(script).not.toMatch(/VIEWS\.overview = /);
    expect(INDEX_HTML).not.toContain('data-tab="overview"');
    expect(script).toContain('function signInBanner(');
    expect(script).toContain("ACTIONS['deny-sign-in']");
  });

  test('read-only is shown on a profile, never switched from the page', () => {
    expect(script).not.toContain("CHANGES['profile-ro']");
    expect(script).not.toContain('data-change="profile-ro"');
    expect(script).toContain('<span class="pill ro">read-only</span>');
    expect(script).toContain('profile update --profile');
  });

  test('profiles: one row per profile, the service named once per group', () => {
    expect(script).not.toContain('<tr class="group">');
    expect(script).toContain('<table class="stack compact">');
    expect(script).toContain('<th>Service</th><th>Profile</th><th>Account</th><th>Link</th><th>Status</th><th>Used by</th>');
  });

  test('a profile link opens apart from the admin, and long details are cut, not wrapped', () => {
    // Every outbound link must deny the target page a handle on the admin's window.
    const blanks = script.match(/target="_blank"[^>]*>/g) ?? [];
    expect(blanks.length).toBeGreaterThan(0);
    for (const tag of blanks) expect(tag).toContain('rel="noopener noreferrer"');
    expect(style).toMatch(/\.clip \{[^}]*text-overflow: ellipsis/);
  });

  test('the locked screen: a drawn padlock that reacts, and stays still for reduced motion', () => {
    expect(script).toContain('function lockArt(');
    for (const state of ['busy', 'nope', 'open', 'peek']) expect(style).toContain(`.lock.${state}`);
    expect(style).toMatch(/@media \(prefers-reduced-motion: reduce\)[^}]*\.lock/);
    expect(script).toContain("prefers-reduced-motion: reduce");
  });

  test('profiles and access share a filter that types without losing the caret', () => {
    expect(script).toContain("INPUTS.filter");
    expect(script).toContain("ACTIONS['clear-filter']");
    expect(script).toContain('matchesFilter(');
    expect(script).toContain('setSelectionRange(');
  });
});

const FAMILY_CSS = `/* family.css: the same file in every product. */
:root {
  color-scheme: light dark;
  --bg: #F8F0E0;
  --fg: #283030;
  --muted: #6B6459;
  --card: #FFFDF8;
  --line: #E4DAC6;
  --code-bg: #F1E9D8;
  --badge-bg: #EFE6D4;
  --strong-bg: #283030;
  --strong-fg: #F8F0E0;
  --display-bg: #283030;
  --ok: #1E7A34;
  --bad: #B42318;
  --warn-bg: #F6DFB2;
  --old-dot: #E4DAC6;
  --link: var(--brand-deep);
  --primary-bg: var(--brand);
  --new-dot: var(--brand);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --size-title: 1.75rem; --size-section: 1.25rem; --size-body: 1rem;
  --size-small: 0.875rem; --size-mono: 0.9375rem;
  --s1: 8px; --s2: 16px; --s3: 24px; --s4: 32px; --s5: 48px; --s6: 64px;
  --radius: 14px; --radius-small: 10px; --tap: 44px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181820;
    --fg: #F1EADB;
    --muted: #A39E94;
    --card: #22232B;
    --line: #34363F;
    --code-bg: #2C2D36;
    --badge-bg: #34363F;
    --strong-bg: #F1EADB;
    --strong-fg: #181820;
    --display-bg: #101615;
    --ok: #5BD07A;
    --bad: #FF6B5E;
    --warn-bg: #4A3A1C;
    --old-dot: #3A3C46;
    --link: var(--link-dark);
  }
}
`;
