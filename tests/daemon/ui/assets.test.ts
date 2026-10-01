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
    for (const name of ['function escapeHtml', 'function parseRoute', 'function needsYou', 'function toggleScope']) expect(script).toContain(name);
    for (const view of ['overview', 'machines', 'machine', 'profiles', 'profile', 'add', 'access', 'settings', 'authorize']) {
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
});
