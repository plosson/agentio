import { describe, expect, test } from 'bun:test';
import { INDEX_HTML } from '../../../src/daemon/ui/assets';

const script = INDEX_HTML.slice(INDEX_HTML.indexOf('<script nonce="__CSP_NONCE__">') + '<script nonce="__CSP_NONCE__">'.length, INDEX_HTML.lastIndexOf('</script>'));
const style = INDEX_HTML.slice(INDEX_HTML.indexOf('<style nonce="__CSP_NONCE__">'), INDEX_HTML.indexOf('</style>'));

describe('the assembled admin page', () => {
  test('every build-time placeholder is filled; only the per-request ones remain', () => {
    expect(INDEX_HTML).not.toContain('/*__STYLES__*/');
    expect(INDEX_HTML).not.toContain('//__SCRIPT__');
    expect(INDEX_HTML).toContain('__PLUGIN_METADATA__');
    expect(INDEX_HTML.match(/__CSP_NONCE__/g)).toHaveLength(2);
  });

  test('one inline script and one inline style, nothing external', () => {
    expect(INDEX_HTML.match(/<script\b/g)).toHaveLength(1);
    expect(INDEX_HTML.match(/<style\b/g)).toHaveLength(1);
    expect(INDEX_HTML).not.toMatch(/<link\b/);
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

  test('the model and every screen are in the script', () => {
    for (const name of ['function escapeHtml', 'function parseRoute', 'function toggleScope']) expect(script).toContain(name);
    for (const view of ['machines', 'machine', 'profiles', 'profile', 'add', 'access', 'settings', 'authorize']) {
      expect(script).toMatch(new RegExp(`VIEWS\\.${view} = `));
    }
  });

  test('no inline style attributes, which the CSP would block', () => {
    expect(INDEX_HTML).not.toMatch(/\sstyle\s*=/);
  });

  test('the style uses the hub font and the wireframe palette', () => {
    expect(style).toContain("url('/ui/fonts/balsamiq-sans-400.woff2')");
    expect(style).toContain("url('/ui/fonts/balsamiq-sans-700.woff2')");
    for (const colour of ['#2b2b2b', '#fdfdfb', '#3b6fd8', '#fff4b8', '#d0453a']) expect(style).toContain(colour);
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
