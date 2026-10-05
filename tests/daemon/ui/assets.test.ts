import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ICON_SVG, INDEX_HTML } from '../../../src/daemon/ui/assets';

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

const UI = join(import.meta.dir, '../../../src/daemon/ui');
const familyCss = readFileSync(join(UI, 'family.css'), 'utf8');
const adminCss = readFileSync(join(UI, 'admin.css'), 'utf8');
const brandCss = readFileSync(join(UI, 'brand.css'), 'utf8');

/** `--role: value` pairs of one CSS block. */
const roles = (block: string) => new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const brandLight = roles(brandCss.slice(0, brandCss.indexOf('@media')));
const brandDark = roles(brandCss.slice(brandCss.indexOf('@media (prefers-color-scheme: dark)'), brandCss.indexOf('@media (pointer: coarse)')));
const brandTouch = roles(brandCss.slice(brandCss.indexOf('@media (pointer: coarse)')));
const familyLight = roles(FAMILY_CSS.slice(0, FAMILY_CSS.indexOf('@media')));

const script = INDEX_HTML.slice(INDEX_HTML.indexOf('<script nonce="__CSP_NONCE__">') + '<script nonce="__CSP_NONCE__">'.length, INDEX_HTML.lastIndexOf('</script>'));
const style = INDEX_HTML.slice(INDEX_HTML.indexOf('<style nonce="__CSP_NONCE__">'), INDEX_HTML.indexOf('</style>'));
const markupAll = () => script + INDEX_HTML;

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
    for (const view of ['overview', 'machines', 'machine', 'profiles', 'profile', 'add', 'access', 'settings', 'authorize', 'connect', 'key']) {
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
    const brand = style.indexOf('--brand: #007AFF;');
    expect(family).toBeGreaterThan(-1);
    expect(brand).toBeGreaterThan(family);
    expect(style.indexOf('/* admin.css')).toBeGreaterThan(brand);
  });

  test('brand.css gives every family colour a macOS value, so no paper colour shows', () => {
    for (const [role, value] of familyLight) {
      if (value.startsWith('#') || value.startsWith('var(')) expect(brandLight.has(role)).toBe(true);
    }
  });

  test('every colour role brand.css sets for light, it sets for dark', () => {
    const sameInBoth = new Set(['--brand', '--brand-top', '--brand-deep', '--link-dark', '--primary-fg']);
    for (const [role, value] of brandLight) {
      if (sameInBoth.has(role)) continue;
      if (value.startsWith('#') || value.startsWith('var(') || value.includes('#')) expect(brandDark.has(role)).toBe(true);
    }
  });

  test('sizes: compact with a mouse, 44 px controls and larger text on a touch screen', () => {
    expect(brandLight.get('--tap')).toBe('24px');
    expect(brandLight.get('--size-body')).toBe('0.8125rem');
    expect(brandTouch.get('--tap')).toBe('44px');
    expect(brandTouch.get('--size-body')).toBe('1rem');
    // The touch block comes last, so it wins over the light and dark blocks.
    expect(brandCss.lastIndexOf('@media (pointer: coarse)')).toBeGreaterThan(brandCss.indexOf('@media (prefers-color-scheme: dark)'));
  });

  test('the Mac palette: system blue for links and the primary button, white on it', () => {
    expect(brandLight.get('--link')).toBe('var(--brand)');
    expect(brandDark.get('--link')).toBe('var(--link-dark)');
    expect(brandDark.get('--primary-bg')).toBe('var(--link-dark)');
    expect(brandLight.get('--primary-fg')).toBe('#FFFFFF');
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
    for (const action of ["ACTIONS['test-one']", "SUBMITS['rename-profile']", "ACTIONS['check-again']", "ACTIONS['delete-profile']", "ACTIONS['pick-service']"]) {
      expect(script).toContain(action);
    }
    expect(script).toContain('reauthCommand(');
    expect(script).toContain('addCommand(');
  });

  test('machines: its actions are registered', () => {
    for (const name of ["ACTIONS['replace-key']", "ACTIONS['revoke-machine']", "ACTIONS['key-done']", "SUBMITS['create-key']", "SUBMITS['save-scope']",
      "SUBMITS['rename-machine']", "CHANGES['machine-ro']", "CHANGES['machine-manage']"]) {
      expect(script).toContain(name);
    }
    expect(script).not.toContain("ACTIONS['toggle-connect']");
    expect(script).not.toContain("ACTIONS['rename-machine']");
    expect(script).toContain('loginCommand(');
    expect(script).toContain('reachableRefs(');
  });

  test('machines: List and Access are two views of one section; Access is no longer a tab', () => {
    expect(INDEX_HTML).not.toContain('data-tab="access"');
    expect(script).toContain("{ id: 'access', href: '#access', label: 'Access' }");
    expect(script).toContain('Change access from each machine’s page.');
  });

  test('key created: shown once, never in the address, and leaving before copying asks first', () => {
    expect(INDEX_HTML).not.toContain('token-dialog');
    expect(INDEX_HTML).not.toContain('rename-dialog');
    expect(script).not.toContain('function showToken(');
    expect(script).not.toMatch(/routeHash\(\{ view: 'key',/);
    expect(script).toContain('This key is shown once.');
    expect(script).toContain('Leave without copying the key?');
    expect(script).toContain("window.addEventListener('beforeunload'");
  });

  test('renaming: what the owner typed survives an error, and is dropped when the rename ends', () => {
    expect(script).toContain('state.ui.renameDraft ?? title');
    expect(script).toMatch(/SUBMITS\['rename-profile'\][\s\S]*?state\.ui\.renameDraft = name;/);
    expect(script).toMatch(/SUBMITS\['rename-machine'\][\s\S]*?state\.ui\.renameDraft = name;/);
    expect(script.match(/state\.ui\.renameDraft = undefined;/g)!.length).toBeGreaterThanOrEqual(5);
  });

  test('approval: one screen — the code, who asks with a live countdown, the presets, Approve or Deny', () => {
    expect(script).not.toContain("ACTIONS['auth-yes']");
    for (const name of ["ACTIONS['auth-deny']", "SUBMITS['auth-approve']"]) expect(script).toContain(name);
    expect(script).toContain('Approve this sign-in?');
    expect(script).toContain("displayPanel('Code', req.userCode)");
    expect(script).toContain('Is this the code on the machine signing in? If not, deny it.');
    expect(script).toContain('data-countdown="${req.expiresAt}"');
    expect(script).toMatch(/name="\$\{prefix\}-preset" value="read-all" checked/);
    expect(script).toContain('This sign-in request has ended or was already answered. Run agentio login again on the machine.');
    expect(script).not.toContain('<span class="steps"');
  });

  test('approval: Approve and Deny cannot run twice, and a late answer never overwrites a finished screen', () => {
    expect(script).toMatch(/ACTIONS\['auth-deny'\] = async \(\) => \{\s*const auth = state\.ui\.auth;\s*if \(auth\.step !== 'ask' \|\| auth\.busy\) return;/);
    expect(script).toMatch(/SUBMITS\['auth-approve'\] = async \(form\) => \{\s*const auth = state\.ui\.auth;\s*if \(auth\.step !== 'ask' \|\| auth\.busy\) return;/);
    expect(script).toContain('function endAuth(auth, res)');
    expect(script.match(/step: 'error', ended: res\.status === 404/g)?.length).toBe(1);
  });

  test('approval: a request that runs out while the screen is open turns into the ended page', () => {
    expect(script).toMatch(/function tick\(\) \{[\s\S]*?=== 'ended'[\s\S]*?step: 'error'/);
  });

  test('system pages: an unreachable hub says so, offers Try again, and when it last loaded', () => {
    expect(script).toContain('function showUnreachable(');
    expect(script).toContain('The hub did not answer');
    expect(script).toContain('Last loaded at');
    expect(script).toContain('ACTIONS.retry');
  });

  test('settings: about, the browser session, and locking in the danger zone', () => {
    expect(script).toContain("pageHead({ title: 'Settings' })");
    expect(script).toContain('<h2>Danger zone</h2>');
    expect(script).toContain('Lock the vault…');
    expect(script).toContain('ACTIONS.lock');
  });

  test('leaving on purpose forgets the shown-once key', () => {
    expect(script).toMatch(/function leaveHub\(locked\) \{[\s\S]*?state\.ui\.shownKey = null;/);
  });

  test('the key leave prompt is not re-entrant', () => {
    expect(script).toMatch(/if \(leavePrompt\) \{\s*history\.replaceState\(null, '', lastHash\);\s*return;/);
    expect(script).toMatch(/leavePrompt = true;[\s\S]*?await confirmDialog[\s\S]*?leavePrompt = false;/);
  });

  test('access: cells toggle through toggleScope, never by hand', () => {
    expect(script).toContain("ACTIONS['toggle-cell']");
    expect(script).toContain('toggleScope(');
    expect(script).toContain('accessCell(');
    expect(script).toContain('Revoke instead');
  });

  test('overview: first tab, the vault in the display panel, recently seen machines, no activity log', () => {
    expect(script).toMatch(/VIEWS\.overview = /);
    expect(INDEX_HTML).toMatch(/<nav class="tabs" id="tabs" aria-label="Main">\s*<a href="#overview" data-tab="overview">Overview<\/a>/);
    expect(script).toContain("displayPanel('In the vault'");
    expect(script).toContain('<h2>Recently seen</h2>');
    expect(script).toContain('recentlySeen(');
    expect(script).toContain('attentionParts(');
    expect(script).not.toMatch(/activity log|Recent activity/i);
  });

  test('read-only is shown on a profile, never switched from the page', () => {
    expect(script).not.toContain("CHANGES['profile-ro']");
    expect(script).not.toContain('data-change="profile-ro"');
    expect(script).toContain('<span>Read-only</span>');
    expect(script).toContain('profile update --profile');
  });

  test('profiles: a grouped list, problems first in each group, no table', () => {
    expect(script).not.toContain('<table class="stack compact">');
    expect(script).not.toContain('group-heading');
    expect(script).toContain('<li class="group">');
    expect(script).toMatch(/<span class="group-name">\$\{icon\(g\.service\)\}/);
    expect(script).toContain('<ul class="group-rows" aria-label="${g.name}">');
    expect(script).toContain('problemsFirst(');
  });

  test('profiles: the service is a column from 600 px and a heading on a phone; lines only between services', () => {
    expect(style).toMatch(/\.list > \.group \{[^}]*\}/);
    expect(style).toMatch(/@media \(min-width: 600px\) \{[^@]*\.list > \.group \{[^}]*display: grid; grid-template-columns: [^;]+ minmax\(0, 1fr\)/);
    expect(style).toMatch(/\.group-rows \{[^}]*list-style: none/);
    expect(style).not.toMatch(/\.group-rows > li \+ li \{[^}]*border/);
  });

  test('profiles: one line per profile on a wide screen, two on a phone; a long value is cut, never wrapped', () => {
    const view = script.slice(script.indexOf('VIEWS.profiles ='), script.indexOf('VIEWS.profile ='));
    expect(view).toContain('dense: true');
    expect(view).toContain('accountShown(r.profile, r.account)');
    expect(view).not.toContain('used by');
    expect(script).toMatch(/function listItem\(\{[^}]*dense[^}]*\}\)/);
    expect(style).toMatch(/\.item\.dense \.item-meta \{[^}]*flex: 1 0 100%/);
    expect(style).toMatch(/@media \(min-width: 600px\) \{[^@]*\.item\.dense > span \{[^}]*flex-wrap: nowrap/);
    expect(style).toMatch(/\.item\.dense \.item-title \{[^}]*text-overflow: ellipsis/);
  });

  test('a profile: Signed in as in the display panel, renamed in place, the reason it is read only', () => {
    expect(script).toContain("displayPanel('Signed in as'");
    expect(script).toContain("submit: 'rename-profile'");
    expect(script).toContain('accessLevel(');
    expect(script).toContain('This profile was removed or renamed.');
  });

  test('add a profile: a filterable list of services and Check again, no tiles', () => {
    expect(script).not.toContain('class="tiles"');
    expect(script).toContain('matchesService(');
    expect(script).toContain('data-input="service-filter"');
  });

  test('a profile link opens apart from the admin, and long details are cut, not wrapped', () => {
    // Every outbound link must deny the target page a handle on the admin's window.
    const blanks = script.match(/target="_blank"[^>]*>/g) ?? [];
    expect(blanks.length).toBeGreaterThan(0);
    for (const tag of blanks) expect(tag).toContain('rel="noopener noreferrer"');
    expect(style).toMatch(/\.clip \{[^}]*text-overflow: ellipsis/);
  });

  test('the gate: the vault icon, two states, the strong button and the help line', () => {
    expect(script).not.toContain('function lockArt(');
    expect(script).toContain(`const VAULT_ICON = ${JSON.stringify(ICON_SVG)};`);
    expect(script).toContain('Unlock the vault');
    expect(script).toContain('Sign in to continue');
    expect(script).toContain("Your agents can't get their keys until you unlock it.");
    expect(script).toContain('The vault is unlocked and your agents keep working.');
    expect(script).toContain("Forgot the passphrase? It can't be recovered.");
    expect(script).toContain('class="button strong wide" id="unlock-btn"');
  });

  test('the gate: motion only on state changes; only the dial turning while checking may loop', () => {
    for (const mood of ['checking', 'nope', 'open']) expect(style).toContain(`.vault.${mood}`);
    expect(style).not.toMatch(/\.lock(?![\w-])/);
    const looping = style.match(/[^{}]+\{[^{}]*infinite[^{}]*\}/g) ?? [];
    expect(looping.length).toBeGreaterThan(0);
    for (const rule of looping) expect(rule.trim().startsWith('.vault.checking')).toBe(true);
  });

  test('the gate: when a session ends mid-task it opens over the screen and cannot be dismissed', () => {
    expect(INDEX_HTML).toContain('<dialog id="gate-dialog" class="dialog gate-dialog" aria-labelledby="gate-title"></dialog>');
    expect(script).toMatch(/function showUnlock\(locked\) \{[\s\S]*?if \(state\.loaded\) \{[\s\S]*?showModal\(\)/);
    expect(script).toContain("$('gate-dialog').addEventListener('cancel', (ev) => ev.preventDefault());");
    // Signing out or locking on purpose leaves the hub: the full-page gate, not the dialog.
    expect(script).toContain('function leaveHub(locked)');
    expect(script).toMatch(/ACTIONS\['sign-out'\] = async \(\) => \{[\s\S]*?leaveHub\(false\)/);
    expect(script).toMatch(/ACTIONS\.lock = async \(\) => \{[\s\S]*?leaveHub\(true\)/);
  });

  test('the gate: after signing back in, a stalled authorize screen renders again and a flipped gate keeps the typed passphrase', () => {
    expect(script).toMatch(/async function openHub\(\) \{[\s\S]*?currentRoute\(\)\.view === 'authorize' && \(!state\.ui\.auth \|\| state\.ui\.auth\.step === 'loading'\)[\s\S]*?\(!formOpen\(\) \|\| stalled\)/);
    expect(script).toContain("$('passphrase').value = typed;");
  });

  test('profiles and access share a filter that types without losing the caret', () => {
    expect(script).toContain("INPUTS.filter");
    expect(script).toContain("ACTIONS['clear-filter']");
    expect(script).toContain('matchesFilter(');
    expect(script).toContain('setSelectionRange(');
  });

  test('components: each exists once, as a helper the screens share', () => {
    for (const helper of ['function statusMarkup(', 'function statusText(', 'function displayPanel(', 'function pageHead(', 'function listItem(',
      'function banner(', 'function emptyState(', 'function command(', 'function segmented(', 'function systemPage(', 'function syncCountdowns(']) {
      expect(script.split(helper)).toHaveLength(2);
    }
    expect(script).not.toContain('function pill(');
    expect(script).not.toContain('statusPill(');
  });

  test('components: long values wrap instead of pushing the page sideways', () => {
    expect(style).toMatch(/\.display \.value \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.item-title \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.command code \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.page-head \.title \{[^}]*min-width: 0/);
  });

  test('components: every control is at least 44 px tall, and the focus ring is visible', () => {
    expect(style).toMatch(/\.button \{[^}]*min-height: var\(--tap\)/);
    expect(style).toMatch(/\.input \{[^}]*min-height: var\(--tap\)/);
    expect(style).toMatch(/:focus-visible \{ outline: 3px solid var\(--link\); outline-offset: 2px; \}/);
  });

  test('motion: everything stops for reduced motion', () => {
    expect(style).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation: none !important; transition: none !important; \} \}/);
  });

  test('a waiting sign-in shows on every screen with a live countdown', () => {
    expect(script).toContain('function signInBanner(');
    expect(script).toContain('data-countdown="${req.expiresAt}"');
    expect(script).toContain("ACTIONS['deny-sign-in']");
  });

  test('no class of the old wireframe look is left, in the markup or the style', () => {
    const legacy = ['box', 'btn', 'pill', 'sketch', 'tiles', 'tile', 'codebox', 'welcome', 'lock', 'tabbar', 'bar', 'section-title', 'grid2', 'grid3', 'hl', 'tog', 'radio', 'filter', 'field', 'compact'];
    const markup = script + INDEX_HTML;
    for (const cls of legacy) {
      expect(markup).not.toMatch(new RegExp(`class="[^"]*(?<![\\w-])${cls}(?![\\w-])`));
      expect(style).not.toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
    }
    expect(style).not.toContain('Legacy');
    expect(style).not.toMatch(/--(ink|pencil|paper|accent|hl|red|green|amber|sketch)\b/);
  });

  test('on-screen words: no "agentio hub", no exclamation mark in a message', () => {
    expect(markupAll()).not.toContain('agentio hub');
    expect(script).not.toMatch(/toast\('[^']*!'/);
  });
});

describe('final review fixes', () => {
  const block = (start: string) => {
    const i = script.indexOf(start);
    expect(i).toBeGreaterThan(-1);
    return script.slice(i, i + 1500);
  };

  test('Deny on the banner leaves open forms alone and cannot be tapped twice', () => {
    const deny = block("ACTIONS['deny-sign-in']");
    expect(deny).toMatch(/el\.disabled = true/);
    expect(deny).toMatch(/if \(formOpen\(\)\) el\.closest\('\.banner'\)\?\.remove\(\);\s*else render\(\);/);
    expect(deny).not.toMatch(/^\s*render\(\);/m);
  });

  test('the rename draft is kept on every input and used by every redraw', () => {
    expect(script).toMatch(/INPUTS\.rename = \(input\) => \{ state\.ui\.renameDraft = input\.value; \};/);
    expect(script).toContain('data-input="rename"');
    expect(script).toContain('value="${state.ui.renameDraft ?? title}"');
    expect(script).not.toContain('state.ui.renameError ? (state.ui.renameDraft ?? title) : title');
  });

  test('every way out of an uncopied key asks once, through one shared dialog', () => {
    expect(script.match(/Leave without copying the key\?/g)).toHaveLength(1);
    expect(script).toMatch(/async function confirmLeaveKey\(\) \{[\s\S]*?shownKey[\s\S]*?copied[\s\S]*?confirmDialog\(LEAVE_KEY\)/);
    expect(script).toMatch(/await confirmDialog\(LEAVE_KEY\)/);
    const out = block("ACTIONS['sign-out']");
    expect(out.indexOf('confirmLeaveKey()')).toBeGreaterThan(-1);
    expect(out.indexOf('confirmLeaveKey()')).toBeLessThan(out.indexOf('/ui/api/logout'));
    const lock = block('ACTIONS.lock');
    expect(lock.indexOf('confirmLeaveKey()')).toBeGreaterThan(-1);
    expect(lock.indexOf('confirmLeaveKey()')).toBeLessThan(lock.indexOf('/ui/api/lock'));
  });

  test('an approval in flight is never reported as ended, and a 201 always lands on done', () => {
    const t = block('function tick()');
    expect(t).toMatch(/state\.ui\.auth\.step === 'ask' && !state\.ui\.auth\.busy/);
    const approve = block("SUBMITS['auth-approve']");
    expect(approve).not.toMatch(/if \(res\.lost\) return;\s*if \(auth\.step !== 'ask'\) return;/);
    expect(approve).toMatch(/if \(!res\.ok\) \{\s*if \(auth\.step !== 'ask'\) return;/);
    expect(approve).toMatch(/auth\.step = 'done';[\s\S]*?state\.keys = /);
  });

  test('Lock reports what happened: nothing on a lost session, an error on failure', () => {
    const lock = block('ACTIONS.lock');
    expect(lock).toMatch(/const res = await api\('\/ui\/api\/lock'/);
    expect(lock).toMatch(/if \(res\.lost\) return;/);
    expect(lock).toMatch(/if \(!res\.ok\) \{ toast\(res\.error, 'error'\); return; \}/);
    expect(lock.indexOf("toast('Vault locked')")).toBeGreaterThan(lock.indexOf('res.ok'));
  });

  test('moving to another page closes the by-hand and scope-edit forms', () => {
    const h = block("window.addEventListener('hashchange'");
    expect(h).toContain('state.ui.byHand = false;');
    expect(h).toContain('state.ui.editScope = null;');
  });

  test('a new page opens at the top with the header in view; focus never scrolls it away', () => {
    const h = block("window.addEventListener('hashchange'");
    expect(h).toContain('main.focus({ preventScroll: true });');
    expect(h).not.toMatch(/main\.focus\(\);/);
    expect(h).toContain('window.scrollTo(0, 0);');
  });
});
