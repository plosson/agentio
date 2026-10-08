import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ICON_SVG, INDEX_HTML } from '../../../src/daemon/ui/assets';
import { escapeHtml, html, raw } from '../../../src/daemon/ui/model';

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

  test('the window: a sidebar with the lockup, the sections and where you are; a list pane; the details', () => {
    expect(INDEX_HTML).toContain('<div class="shell bare" id="shell">');
    expect(INDEX_HTML).toMatch(/<aside class="sidebar" id="bar" hidden>\s*<a class="lockup" href="#overview"><img src="\/ui\/icon.svg\?v=__VERSION__" alt="" width="26" height="26">agentio<\/a>/);
    expect(INDEX_HTML).toContain('<nav class="tabs" id="tabs" aria-label="Main">');
    expect(INDEX_HTML).toContain('<span class="count" id="profiles-count"></span>');
    expect(INDEX_HTML).toContain('<span class="count" id="machines-count"></span>');
    expect(INDEX_HTML).toMatch(/<div class="where"><span id="hub-host"><\/span><span id="version"><\/span><button[^>]*class="button link sign-out"[^>]*data-action="sign-out"/);
    expect(INDEX_HTML).toContain('<section class="list-pane" id="list" aria-label="List"></section>');
    expect(INDEX_HTML).toContain('<main id="main" tabindex="-1"></main>');
    // Gone with the header: the phone menu, its button and the footer.
    expect(INDEX_HTML).not.toContain('menu-button');
    expect(INDEX_HTML).not.toContain('menu-only');
    expect(INDEX_HTML).not.toContain('<footer');
    expect(INDEX_HTML).not.toContain('<header');
    expect(script).not.toContain("ACTIONS['toggle-menu']");
    expect(script).not.toContain('closeMenu');
  });

  test('render draws the list beside the details, keeps the list where it was, and puts focus back', () => {
    const r = script.slice(script.indexOf('function render()'), script.indexOf('// ---------- Waiting sign-ins'));
    expect(r).toContain('const panes = paneOf(route);');
    expect(r).toContain('LISTS[panes.list]');
    expect(r).toMatch(/classList\.toggle\('no-list', !lister\)/);
    expect(r).toMatch(/classList\.toggle\('selected', panes\.selected\)/);
    // The same list keeps its scroll (kept in state, since a hidden pane loses it); another list starts at the top.
    expect(r).toContain('if (list.dataset.list !== (panes.list || \'\')) delete state.ui.listScroll[panes.list];');
    expect(r).toContain('list.scrollTop = state.ui.listScroll[panes.list] || 0;');
    expect(r).not.toMatch(/=\s*list\.scrollTop/);
    expect(r.indexOf('list.scrollTop =')).toBeGreaterThan(r.indexOf('list.innerHTML ='));
    // Focus is restored after both panes are drawn, so the filter box in the list keeps its caret.
    expect(r.indexOf('again.focus()')).toBeGreaterThan(r.indexOf('list.innerHTML ='));
    expect(r.indexOf('again.focus()')).toBeGreaterThan(r.indexOf('main.innerHTML ='));
  });

  test('a waiting sign-in shows under the head of the details, never above it, and never on the approval page', () => {
    const r = script.slice(script.indexOf('function render()'), script.indexOf('// ---------- Waiting sign-ins'));
    expect(r).toContain("main.querySelector(':scope > .pane-head')");
    expect(r).toContain("insertAdjacentHTML('afterend', pending)");
    expect(r).toContain("route.view === 'authorize' ? ''");
    const overview = script.slice(script.indexOf('VIEWS.overview ='), script.indexOf('function firstRun('));
    expect(overview.indexOf("pageHead({ title: 'Overview' })")).toBeGreaterThan(-1);
    expect(overview.indexOf("pageHead({ title: 'Overview' })")).toBeLessThan(overview.indexOf('${parts.length ? banner('));
  });

  test('the gate and the unreachable page fill the window: the chrome goes through showChrome only', () => {
    expect(script.split('function showChrome(')).toHaveLength(2);
    expect(script).toMatch(/function showUnlock\(locked\) \{[\s\S]*?showChrome\(false\);/);
    expect(script).toMatch(/function showUnreachable\(\) \{\s*showChrome\(false\);/);
    expect(script).not.toContain("$('bar').hidden = true;");
    expect(script).not.toContain("$('version').hidden");
  });

  test('inside AgentIO Companion: the app class, room for the window buttons, no text selected on click', () => {
    expect(script).toContain("if (window.agentioCompanion?.present === true) document.documentElement.classList.add('app');");
    expect(style).toMatch(/:root\.app body \{[^}]*user-select: none/);
    expect(style).toMatch(/:root\.app :is\(input, textarea, select, code, \.mono, \.display \.value\) \{[^}]*user-select: text/);
    expect(style).toMatch(/:root\.app \.sidebar \{[^}]*padding-top: 44px/);
    expect(style).not.toContain('app-region');
  });

  test('inside AgentIO Companion: an empty part of the sidebar or a header drags the window', () => {
    const drag = script.match(/document\.addEventListener\('mousedown', \(ev\) => \{[\s\S]*?\n\}\);/)?.[0] ?? '';
    // Only in the app, only the main button, not on a double-click, and only when the app has the call.
    expect(drag).toContain("document.documentElement.classList.contains('app')");
    expect(drag).toContain('ev.button !== 0');
    expect(drag).toContain('ev.detail > 1');
    expect(drag).toContain('window.agentioCompanion.dragWindow?.()');
    // Controls keep their clicks: the check for them comes before the call.
    expect(script).toMatch(/const WINDOW_CONTROLS = 'a, button, input, select, textarea, label, summary, \[data-action\], \[role="button"\]';/);
    expect(drag.indexOf('closest(WINDOW_CONTROLS)')).toBeGreaterThan(-1);
    expect(drag.indexOf('closest(WINDOW_CONTROLS)')).toBeLessThan(drag.indexOf('dragWindow'));
    // The drag areas: the sidebar, the pane headers, and the bare page's own background (the gate).
    expect(drag).toContain("closest('.sidebar, .pane-head')");
    expect(drag).toContain("matches('.shell.bare > #main')");
    // The list's rows and the details' content stay clickable and selectable.
    expect(drag).not.toMatch(/closest\('[^']*(\.list-pane|#main|\.rows)/);
  });

  test('inside AgentIO Companion: a key that cannot manage profiles gets a "Sign in again" banner', () => {
    const fn = script.match(/function appKeyBanner\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    // Only when the app says so, exactly false: no bridge, an older app, or an unknown right shows nothing.
    expect(fn).toContain('window.agentioCompanion?.canManageProfiles !== false');
    expect(fn).toContain('Sign in again');
    expect(fn).toContain('data-action="app-sign-in-again"');
    // The button asks the app; an older app without the call does nothing rather than throw.
    expect(script).toMatch(/ACTIONS\['app-sign-in-again'\] = \(\) => window\.agentioCompanion\?\.signInAgain\?\.\(\);/);
    // It joins the waiting sign-ins under the header, and stays off the approval page.
    expect(script).toContain("const pending = route.view === 'authorize' ? '' : appKeyBanner().__html + signInBanner().__html;");
  });

  test('an empty vault welcomes the owner with service cards, not a command', () => {
    const first = script.slice(script.indexOf('function firstRun('), script.indexOf('// ---------- Add one service'));
    expect(first).toContain('Welcome to your vault');
    expect(first).toContain('<img class="welcome-icon" src="/ui/icon.svg?v=${state.version}" alt="">');
    expect(first).toContain('welcomeServices(addableServices(), FEATURED, Boolean(state.ui.allServices), displayName)');
    // Each card is a button that opens the sheet for its service, with the service's tile and name.
    expect(first).toMatch(/<button type="button" class="svc-card" data-action="add-service" data-service="\$\{id\}">\$\{tile\(id\)\}/);
    expect(first).toContain('data-action="all-services"');
    expect(first).toContain('href="#connect"');
    // The old first run is gone: no command on the page itself.
    expect(first).not.toContain('command(');
    expect(script).not.toContain('Two steps get an agent going');
  });

  test('adding one service: a sheet with the command, closed by Close, Esc, or Check again', () => {
    expect(INDEX_HTML).toContain('<dialog id="add-dialog" class="dialog add-dialog" aria-labelledby="add-title"></dialog>');
    const add = script.slice(script.indexOf('// ---------- Add one service'), script.indexOf("ACTIONS['all-services']"));
    // Only a service this hub can add opens a sheet; anything else (a stale or forged button) does nothing.
    expect(add).toMatch(/if \(!addableServices\(\)\.includes\(service\)\) return;/);
    expect(add).toContain('command(addCommand(service))');
    expect(add).toContain("modal('add-dialog')");
    // The sheet's markup goes through html``, so a service name cannot inject markup.
    expect(add).toMatch(/\$\('add-dialog'\)\.innerHTML = html`/);
    expect(add).toContain('<form method="dialog" class="actions">');
    expect(add).toContain('value="check"');
    expect(add).toMatch(/=== 'check'\) ACTIONS\['check-again'\]\(\)/);
    // The Add page and the welcome page list the same services.
    expect(script.split('function addableServices(')).toHaveLength(2);
    expect(script).toContain("VIEWS.add = () => {\n  const services = addableServices()");
  });

  test('inside the app, every service is added by the app, not by a command', () => {
    const fn = script.match(/function addInApp\(service\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    // Only when the page runs in the app, the key may manage profiles, and the app has the call; any service.
    expect(fn).toContain('window.agentioCompanion?.canManageProfiles !== true');
    expect(fn).not.toContain('PLUGIN_METADATA');
    expect(fn).toContain("typeof window.agentioCompanion.addProfile !== 'function'");
    expect(fn).toContain('window.agentioCompanion.addProfile(service, displayName(service))');
    // The welcome card and the Add page try the app first, then fall back to the command.
    expect(script).toMatch(/ACTIONS\['add-service'\] = async \(el\) => \{\s*const service = el\.dataset\.service;\s*if \(!addableServices\(\)\.includes\(service\)\) return;\s*if \(addInApp\(service\)\) return;/);
    expect(script).toMatch(/ACTIONS\['pick-service'\] = \(el\) => \{\s*if \(el\.dataset\.service && addInApp\(el\.dataset\.service\)\) return;/);
    // No service is left to the terminal inside the app.
    expect(script).not.toContain('onlyFromTerminal');
    expect(script).not.toContain('Add this one from a terminal for now.');
    expect(script).not.toContain('?.json');
  });

  test('inside the app, a failed profile is signed in again by the app, then tested again', () => {
    const fn = (script.match(/function canReauthInApp\(service\) \{[\s\S]*?\n\}/)?.[0] ?? '') + (script.match(/function reauthInApp\(service, profile\) \{[\s\S]*?\n\}/)?.[0] ?? '');
    expect(fn).toContain('window.agentioCompanion?.canManageProfiles !== true');
    expect(fn).toContain('!PLUGIN_METADATA[service]?.reauth');
    expect(fn).toContain("typeof window.agentioCompanion.reauth === 'function'");
    expect(fn).toContain('window.agentioCompanion.reauth(service, profile, displayName(service))');
    const view = script.slice(script.indexOf('VIEWS.profile ='), script.indexOf('VIEWS.add ='));
    expect(view).toContain('canReauthInApp(r.service)');
    expect(view).toContain('<button class="button primary" data-action="reauth-in-app" data-ref="${ref}">Sign in again</button>');
    // Both failing states offer it; the command block remains the fallback.
    expect(view.match(/\$\{signInAgain\}/g)).toHaveLength(2);
    expect(view).toContain('command(fix)');
    expect(script).toMatch(/ACTIONS\['reauth-in-app'\] = \(el\) => \{[\s\S]*?indexOf\('\/'\)[\s\S]*?reauthInApp\(/);
    const listener = script.match(/window\.addEventListener\('agentio:profiles-changed', [\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(listener.match(/testProfiles\(\[/g)).toHaveLength(1);
    expect(listener.indexOf('testProfiles(')).toBeGreaterThan(listener.indexOf('await loadAll()'));
    expect(listener).toContain('`${service}/${profile}`');
  });

  test('"Signed in as" never shows the service address', () => {
    // loadAll's row mapping must carry serviceUrl, or the page never sees it.
    expect(script).toMatch(/account: p\.account, url: p\.url, serviceUrl: p\.serviceUrl \}/);
    expect(script).toContain("displayPanel('Signed in as', r.account || (r.url && !r.serviceUrl ? linkLabel(r.url) : r.profile)");
  });

  test('after the app adds a profile, the page reloads and opens it', () => {
    const listener = script.match(/window\.addEventListener\('agentio:profiles-changed', [\s\S]*?\n\}\);/)?.[0] ?? '';
    expect(listener).toContain('await loadAll()');
    expect(listener).toContain("routeHash({ view: 'profile', ref: `${service}/${profile}` })");
    // A detail that is not two strings opens the list instead of a broken route.
    expect(listener).toContain("typeof service === 'string' && typeof profile === 'string'");
  });

  test('the browser title follows the H1: "<H1> · agentio"', () => {
    expect(script).toContain('function setTitle(');
    expect(script).toContain("`${h1.textContent.trim()} · agentio`");
  });

  test('layout: sidebar, list and details from 900 px; one pane at a time below', () => {
    expect(style).toMatch(/\.shell \{[^}]*grid-template-columns: 220px 300px minmax\(0, 1fr\)/);
    expect(style).toMatch(/\.shell\.no-list \{[^}]*grid-template-columns: 220px minmax\(0, 1fr\)/);
    expect(style).toMatch(/\.shell\.bare \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(style).toMatch(/@media \(max-width: 899px\) \{[\s\S]*?\.shell\.selected > \.list-pane \{ display: none; \}/);
    expect(style).toMatch(/@media \(max-width: 899px\) \{[\s\S]*?\.pane-head \.back \{[^}]*display: inline-flex/);
    expect(style).not.toMatch(/\.columns \{[^}]*grid/);
    expect(style).not.toMatch(/\.page \{/);
  });

  test('the window never scrolls: each scrolling pane holds its screen-reader text, which would otherwise stick out below the window', () => {
    expect(style).toMatch(/\.sr-only \{[^}]*position: absolute/);
    expect(style).toMatch(/\.sidebar, \.list-pane, #main \{[^}]*position: relative/);
    expect(style).toMatch(/\.sidebar, \.list-pane, #main \{[^}]*overflow: auto/);
  });

  test('the gate and system pages are never hidden on a narrow window', () => {
    const narrow = style.slice(style.indexOf('@media (max-width: 899px)'));
    expect(narrow).toContain('.shell:not(.selected):not(.no-list):not(.bare) > #main { display: none; }');
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

  test('machines: a list pane with Access and Connect in its toolbar; Access opens with a way back', () => {
    expect(INDEX_HTML).not.toContain('data-tab="access"');
    const list = script.slice(script.indexOf('LISTS.machines ='), script.indexOf('VIEWS.machine ='));
    expect(list).toContain('href="#access"');
    expect(list).toContain('href="#connect"');
    expect(list).toContain('machineItem(k, now, k.id === current)');
    expect(list).toContain('loginCommand(location.origin)');
    expect(script).toMatch(/function machineItem\(k, now, current = false\)/);
    expect(script).toContain("pageHead({ path: [{ href: '#machines', label: 'Machines' }], title: 'Access' })");
    expect(script).toContain('Change access from each machine’s page.');
    expect(script).toContain('Choose a machine in the list to see it here.');
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
    expect(INDEX_HTML).toMatch(/<nav class="tabs" id="tabs" aria-label="Main">\s*<a href="#overview" data-tab="overview">/);
    expect(script).toContain("displayPanel('In the vault'");
    expect(script).toContain('<h2>Recently seen</h2>');
    expect(script).toContain('recentlySeen(');
    expect(script).toContain('attentionParts(');
    expect(script).not.toMatch(/activity log|Recent activity/i);
  });

  test('read-only is shown on a profile, never switched from the page', () => {
    expect(script).not.toContain("CHANGES['profile-ro']");
    expect(script).not.toContain('data-change="profile-ro"');
    expect(script).toContain('profile update --profile');
  });

  test('profiles: the list pane groups profiles under a plain service heading, problems first', () => {
    const list = script.slice(script.indexOf('LISTS.profiles ='), script.indexOf('VIEWS.profile ='));
    expect(list).toContain('groupProfiles(visible, displayName)');
    expect(list).toContain('problemsFirst(g.rows, state.results)');
    expect(list).toContain('<h2 class="group-name">${g.name}</h2>');
    expect(list).toContain('<ul class="rows" aria-label="${g.name}">');
    expect(list).not.toMatch(/group-name">\$\{icon\(/);
    expect(list).toContain('lead: tile(r.service)');
    expect(list).toContain('current: ref === current');
    expect(list).toContain('accountShown(r.profile, r.account) ? r.account : displayName(r.service)');
    expect(list).toContain('href="#add"');
    expect(list).toContain('data-action="test-all"');
  });

  test('profiles: the details pane no longer lists the profiles; it asks to choose one', () => {
    const view = script.slice(script.indexOf('VIEWS.profiles ='), script.indexOf('LISTS.profiles ='));
    expect(view).not.toContain('listItem(');
    expect(view).toContain('Choose a profile in the list to see it here.');
  });

  test("a row's status dot carries its word, for screen readers and as a tooltip", () => {
    const item = script.slice(script.indexOf('function listItem('), script.indexOf('function banner('));
    expect(item).toContain('<span class="dot ${dot.tone}" title="${dot.word}" aria-hidden="true"></span><span class="sr-only">${dot.word}</span>');
    expect(item).toContain('aria-current="page"');
    expect(item).not.toContain('dense');
    const list = script.slice(script.indexOf('LISTS.profiles ='), script.indexOf('VIEWS.profile ='));
    expect(list).toContain('dot: statusWord(effectiveStatus(r, state.results).status, isSession(r.service))');
  });

  test('tile() escapes the colour and the letter, and never uses a style attribute', () => {
    const t = script.slice(script.indexOf('function tile('), script.indexOf('const GLYPHS'));
    expect(t).toContain('fill="${escapeHtml(colour)}"');
    expect(t).toContain('escapeHtml((displayName(service)[0] || ');
    expect(t).toContain('<g fill="white" transform="translate(5 5) scale(0.5833)">');
    expect(t).not.toMatch(/style=/);
    expect(script.split('function tile(')).toHaveLength(2);
    expect(script.split('function glyph(')).toHaveLength(2);
  });

  test('a multi-colour icon keeps its own colours, full size, outside the white group; corners clipped in CSS', () => {
    const t = script.slice(script.indexOf('function tile('), script.indexOf('const GLYPHS'));
    expect(t).toContain('fill="${escapeHtml(fill)}"');
    expect(t).not.toContain('clipPath');
    const ICONS = {
      multi: ['Multi', null, [['#123456', 'M0 0h24v24H0z'], ['"><script>', 'M1 1h2']]],
      single: ['Single', '#abcdef', 'M2 2h4'],
    };
    const tile = new Function('escapeHtml', 'raw', 'ICONS', 'PLUGIN_METADATA', 'displayName', `${t}; return tile;`)(
      escapeHtml, raw, ICONS, {}, (s: string) => (ICONS as any)[s]?.[0] || s);
    const multi: string = tile('multi').__html;
    expect(multi).toContain('<rect width="24" height="24" rx="5.5"/>');
    expect(multi).not.toContain('<g fill="white"');
    expect(multi).toContain('<path fill="#123456" d="M0 0h24v24H0z"/>');
    expect(multi).toContain('<path fill="&quot;&gt;&lt;script&gt;" d="M1 1h2"/>');
    expect(multi).not.toContain('<script>');
    // The paths come after the tile's rect, so they sit on it.
    expect(multi.indexOf('<path')).toBeGreaterThan(multi.indexOf('<rect'));
    const single: string = tile('single').__html;
    expect(single).toContain('<g fill="white" transform="translate(5 5) scale(0.5833)"><path d="M2 2h4"/></g>');
    const letter: string = tile('nothing').__html;
    expect(letter).toMatch(/<g fill="white" transform="translate\(5 5\) scale\(0\.5833\)"><text [^>]*>N<\/text><\/g>/);
    expect(style).toMatch(/\.svc-tile \{[^}]*clip-path: inset\(0 round 23%\)/);
  });

  test('a tile with no brand colour is grey, and the logo stays white in both modes', () => {
    expect(style).toMatch(/\.svc-tile rect:not\(\[fill\]\) \{ fill: var\(--muted\); \}/);
    expect(adminCss).not.toMatch(/\.svc-tile g \{/);
  });

  test('inside the app, a profile row has a right-click menu with its actions', () => {
    const fn = script.match(/function profileMenu\(ref\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const menuFor = (app: unknown, rows: Record<string, unknown>, reauth = false) =>
      new Function('rowByRef', 'canReauthInApp', 'window', `${fn}; return profileMenu;`)(
        (ref: string) => rows[ref], () => reauth, { agentioCompanion: app });
    const rows = { 'kite/a b': { service: 'kite', profile: 'a b' } };
    const app = { present: true, contextMenu: () => null };
    expect(menuFor(app, rows, true)('kite/a b')).toEqual([
      { id: 'test', title: 'Test' },
      { id: 'sign-in-again', title: 'Sign In Again' },
      { id: 'rename', title: 'Rename…' },
      { id: 'copy-name', title: 'Copy Profile Name' },
      '-',
      { id: 'delete', title: 'Delete Profile…' },
    ]);
    // Sign In Again only where the app can do it.
    expect(menuFor(app, rows, false)('kite/a b').map((e: any) => e.id ?? e)).toEqual(['test', 'rename', 'copy-name', '-', 'delete']);
    // In a browser, an older app without the call, or for a profile that is gone: no menu, the usual one shows.
    expect(menuFor(undefined, rows)('kite/a b')).toBeNull();
    expect(menuFor({ present: true }, rows)('kite/a b')).toBeNull();
    expect(menuFor({ present: true, contextMenu: 'x' }, rows)('kite/a b')).toBeNull();
    expect(menuFor(app, rows)('kite/gone')).toBeNull();
    // Every id has its action, and each action is the page's own.
    const actions = script.slice(script.indexOf('const PROFILE_MENU = {'), script.indexOf('};', script.indexOf('const PROFILE_MENU = {')));
    for (const id of ["test:", "'sign-in-again':", 'rename:', "'copy-name':", 'delete:']) expect(actions).toContain(id);
    expect(actions).toContain('testProfiles([ref])');
    expect(actions).toContain("ACTIONS['reauth-in-app']({ dataset: { ref } })");
    expect(actions).toContain("ACTIONS['start-rename']({ dataset: { key: `profile:${ref}` } })");
    expect(actions).toContain('copyText(ref)');
    expect(actions).toContain("ACTIONS['delete-profile']({ dataset: { ref } })");
    // Rows carry their ref for the menu; the right-click asks the app, and only a known id acts.
    expect(script).toContain('menuRef: ref,');
    const handler = script.slice(script.indexOf("document.addEventListener('contextmenu'"), script.indexOf('});', script.indexOf("document.addEventListener('contextmenu'")));
    expect(handler).toContain("ev.target.closest('[data-menu-ref]')");
    // The app swaps its items into the menu it opens for this very click: cancelling it would open none.
    expect(handler).not.toContain('preventDefault');
    expect(handler).toContain('Object.hasOwn(PROFILE_MENU, picked)');
  });

  test('a list row carries its menu ref only when it has one, escaped', () => {
    const fn = script.match(/function listItem\(\{[\s\S]*?\n\}/)?.[0] ?? '';
    const listItem = new Function('html', 'raw', `${fn}; return listItem;`)(html, raw);
    expect(listItem({ href: '#p', title: 't', menuRef: 'kite/"><b>x' }).__html).toContain('data-menu-ref="kite/&quot;&gt;&lt;b&gt;x"');
    expect(listItem({ href: '#p', title: 't' }).__html).not.toContain('data-menu-ref');
  });

  test('read-only shows in the profile row', () => {
    expect(script).toContain("r.readOnly ? ' · Read-only' : ''");
  });

  test("a profile's page leads with its service tile", () => {
    const view = script.slice(script.indexOf('VIEWS.profile ='), script.indexOf('VIEWS.add ='));
    expect(view).toContain("<div class=\"lead-panel\">${tile(r.service, 'lg')}${displayPanel('Signed in as'");
  });

  test('the status in a selected row takes the row\'s text colour, not its tone', () => {
    expect(style).toContain('.list-pane .item[aria-current="page"] .status { color: inherit; }');
    // Placed after the tone rules, so it still wins should its selector ever lose specificity.
    expect(style.indexOf('.list-pane .item[aria-current="page"] .status')).toBeGreaterThan(style.indexOf('.status.ok {'));
  });

  test('the list keeps its scroll in state, from a listener registered once', () => {
    expect(script).toMatch(/ui: \{[^}]*listScroll: \{\}/);
    const listeners = script.match(/\$\('list'\)\.addEventListener\('scroll'/g) || [];
    expect(listeners).toHaveLength(1);
    const boot = script.slice(script.indexOf("$('list').addEventListener('scroll'"));
    const handler = boot.slice(0, boot.indexOf('});'));
    // Nothing is stored for a pane with no list.
    expect(handler).toMatch(/if \(!list\.dataset\.list\) return;/);
    expect(handler).toContain('state.ui.listScroll[list.dataset.list] = list.scrollTop;');
    // Not inside render(): a redraw must not register another listener.
    const r = script.slice(script.indexOf('function render()'), script.indexOf('// ---------- Waiting sign-ins'));
    expect(r).not.toContain("addEventListener('scroll'");
  });

  test('the back link keeps a space between its chevron and its label on a narrow window', () => {
    expect(style).toMatch(/@media \(max-width: 899px\) \{[\s\S]*?\.pane-head \.back \{[^}]*display: inline-flex[^}]*gap: 4px/);
  });

  test('"/" does nothing when the filter box is hidden', () => {
    const keys = script.slice(script.indexOf("document.addEventListener('keydown'"), script.indexOf("document.addEventListener('submit'"));
    expect(keys).toContain('if (!box || !box.offsetParent) return;');
    expect(keys.indexOf('!box.offsetParent')).toBeLessThan(keys.indexOf('ev.preventDefault();\n  box.focus()'));
  });

  test('the list pane: search box with a magnifier, selected row in the accent colour, old grouped list gone', () => {
    expect(script).toMatch(/function filterBox\(shown, total\) \{[\s\S]*?<div class="search">\$\{glyph\('search'\)\}/);
    expect(script).toContain('placeholder="Search (press /)"');
    expect(style).toMatch(/\.list-pane \.item\[aria-current="page"\] \{[^}]*background: var\(--link\)/);
    expect(style).not.toMatch(/\.list > \.group/);
    expect(style).not.toMatch(/\.group-rows/);
    expect(style).not.toMatch(/\.item\.dense/);
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
      'function banner(', 'function emptyState(', 'function command(', 'function systemPage(', 'function syncCountdowns(']) {
      expect(script.split(helper)).toHaveLength(2);
    }
    expect(script).not.toContain('function segmented(');
    expect(script).not.toContain('machineViews');
    expect(style).not.toContain('.segmented');
    expect(script).not.toContain('function pill(');
    expect(script).not.toContain('statusPill(');
  });

  test('components: long values wrap instead of pushing the page sideways', () => {
    expect(style).toMatch(/\.display \.value \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.item-title \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.command code \{[^}]*overflow-wrap: anywhere/);
    expect(style).toMatch(/\.pane-head \.title \{[^}]*min-width: 0/);
  });

  test('components: every control is as tall as --tap (44 px on touch screens), and the focus ring is visible', () => {
    expect(style).toMatch(/\.button \{[^}]*min-height: var\(--tap\)/);
    expect(style).toMatch(/\.input \{[^}]*min-height: var\(--tap\)/);
    // The Mac focus ring: translucent accent, hugging the control. Never removed, never the old 2 px gap.
    expect(adminCss).toMatch(/--focus-ring: color-mix\(in srgb, var\(--link\) \d+%, transparent\);/);
    expect(style).toMatch(/\n:focus-visible \{ outline: 3px solid var\(--focus-ring\); outline-offset: 0; \}/);
    expect(style).toMatch(/\.switch input:focus-visible \+ span \{ outline: 3px solid var\(--focus-ring\); outline-offset: 0; \}/);
    expect(adminCss).not.toContain('outline-offset: 2px');
    // No control sets a fixed height of its own: it would ignore the touch size.
    expect(adminCss).not.toMatch(/\.(button|input)[^{]*\{[^}]*\bheight: \d/);
  });

  test('Mac components: raised buttons, light panels, small grey captions over grouped lists', () => {
    expect(style).toMatch(/\.button \{[^}]*box-shadow: var\(--shadow\)/);
    expect(style).toMatch(/\.display \{[^}]*background: var\(--card\)/);
    expect(style).not.toMatch(/\.display \.label \{[^}]*text-transform: uppercase/);
    expect(style).toMatch(/\nh2 \{[^}]*color: var\(--muted\)/);
    expect(style).toMatch(/dialog\.dialog h2 \{[^}]*color: var\(--fg\)/);
    expect(style).not.toMatch(/\.empty-state \{[^}]*dashed/);
  });

  test('status dots use the system colours, one per tone', () => {
    for (const tone of ['ok', 'bad', 'warn']) expect(style).toContain(`.dot.${tone} { background: var(--dot-${tone}); }`);
    expect(style).toContain('.dot.neutral { background: var(--old-dot); }');
  });

  test('switches are Mac-sized with a mouse and 51 by 31 on a touch screen', () => {
    expect(style).toMatch(/:root \{[^}]*--switch-w: 32px; --switch-h: 19px;/);
    expect(style).toMatch(/@media \(pointer: coarse\) \{ :root \{ --switch-w: 51px; --switch-h: 31px; \} \}/);
    expect(style).toMatch(/\.switch \{[^}]*width: var\(--switch-w\); height: var\(--switch-h\)/);
    expect(style).toMatch(/\.switch input:checked \+ span::after \{ transform: translateX\(calc\(var\(--switch-w\) - var\(--switch-h\)\)\); \}/);
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

  test('a new page opens at the top of the details; focus never scrolls it away', () => {
    const h = block("window.addEventListener('hashchange'");
    expect(h).toContain('main.focus({ preventScroll: true });');
    expect(h).not.toMatch(/main\.focus\(\);/);
    expect(h).toContain('main.scrollTo(0, 0);');
    expect(script).not.toContain('window.scrollTo(');
  });
});
