# Site Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static, drift-prone `site/` with a build-pipeline-driven site (homepage + changelog + per-service pages), styled like vibeisland.app, where service content auto-regenerates from the live Commander tree.

**Architecture:** A single Bun build script (`scripts/build-site.ts`) reads source HTML/CSS templates, per-service Markdown stubs with frontmatter, and the live Commander tree to emit a static `site/dist/` tree. Cloudflare Pages deploys `site/dist/`. CI rebuilds on changes to `site/`, `src/commands/`, `src/mcp/`, or any tag push.

**Tech Stack:**
- Build runtime: Bun (existing)
- Frontmatter parser: `gray-matter` (already installed)
- Markdown renderer: `marked` (new dep, small, typed)
- Templating: plain string replacement on `{{token}}` placeholders — no template engine
- Deploy: Cloudflare Pages via `wrangler pages deploy site/dist`
- Testing: Bun's built-in `bun:test`

**Spec:** `docs/superpowers/specs/2026-05-09-site-rework-design.md`

---

## File Structure (new and modified)

**Created:**
- `scripts/build-site.ts` — orchestrator
- `scripts/build-site/frontmatter.ts` — frontmatter wrapper (validation)
- `scripts/build-site/services.ts` — service page generation
- `scripts/build-site/changelog.ts` — git → grouped releases
- `scripts/build-site/render.ts` — layout/template renderer
- `scripts/build-site/commands.ts` — Commander tree → HTML reference
- `scripts/build-site/mcp-tools.ts` — MCP tools → HTML reference
- `scripts/build-site/__tests__/frontmatter.test.ts`
- `scripts/build-site/__tests__/changelog.test.ts`
- `scripts/build-site/__tests__/services.test.ts`
- `scripts/build-site/__tests__/commands.test.ts`
- `site/src/_layout.html`
- `site/src/styles.css`
- `site/src/index.html`
- `site/src/changelog.html`
- `site/src/services/_service.html`
- `site/src/services/<slug>.md` — 18 stubs (one per registered service)
- `site/src/privacy.html` — rewrapped legal
- `site/src/terms.html` — rewrapped legal
- `site/public/install`, `site/public/install.ps1`, `site/public/logo.png` (moved)
- `site/public/favicon.ico`, `site/public/favicon-32.png` (new — minimal)

**Modified:**
- `package.json` — add `build:site` script + `marked` dep
- `.gitignore` — add `site/dist/`
- `.github/workflows/deploy-site.yml` — build step + new triggers

**Deleted (replaced by templates):**
- `site/index.html`
- `site/privacy.html`
- `site/terms.html`

---

## Task 1: Scaffolding — build script entrypoint, .gitignore, package script

**Files:**
- Create: `scripts/build-site.ts`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create the build script skeleton**

```typescript
// scripts/build-site.ts
/**
 * Builds the agentio website into site/dist/.
 * Single entrypoint; submodules under scripts/build-site/ do the work.
 */
async function main(): Promise<void> {
  console.log('build-site: starting');
  console.log('build-site: done (no-op for now)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

Open `package.json`. In the `"scripts"` block, add:

```json
"build:site": "bun scripts/build-site.ts"
```

- [ ] **Step 3: Add `site/dist/` to .gitignore**

Append to `.gitignore`:

```
# site build output
site/dist
```

- [ ] **Step 4: Verify it runs**

Run: `bun run build:site`
Expected output:
```
build-site: starting
build-site: done (no-op for now)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site.ts package.json .gitignore
git commit -m "feat(site): scaffold build-site script"
```

---

## Task 2: Add `marked` dependency

**Files:**
- Modify: `package.json`, `bun.lock`

- [ ] **Step 1: Install marked**

Run: `bun add marked`
Expected: `marked` appears in `dependencies` of `package.json`, `bun.lock` updated.

- [ ] **Step 2: Smoke-test it works**

Run:
```bash
bun -e "import { marked } from 'marked'; console.log(marked('# Hi'))"
```
Expected: `<h1>Hi</h1>` printed.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore(site): add marked for markdown rendering"
```

---

## Task 3: Design tokens — `site/src/styles.css`

**Files:**
- Create: `site/src/styles.css`

- [ ] **Step 1: Write the stylesheet**

```css
/* site/src/styles.css — design tokens + base + components, no preprocessor */

:root {
  --bg: #151518;
  --surface: #1c1c20;
  --text: #e5e5e5;
  --muted: #888;
  --accent: #d97757;
  --border: #ffffff14;
  --font-display: "Instrument Serif", Georgia, serif;
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --content-max: 1060px;
  --radius: 10px;
  --transition: 160ms ease;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

/* subtle grain on the body — same SVG noise technique as vibeisland */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size: 200px 200px;
  opacity: 0.03;
  mix-blend-mode: overlay;
  z-index: 1;
}

main, nav, footer { position: relative; z-index: 2; }

a { color: var(--accent); text-decoration: none; transition: opacity var(--transition); }
a:hover { opacity: 0.8; }

code, pre {
  font-family: var(--font-mono);
  font-size: 0.92em;
}

pre {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 20px;
  overflow-x: auto;
  line-height: 1.55;
}

:not(pre) > code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
}

h1, h2, h3 { font-weight: 600; line-height: 1.2; margin: 0 0 0.5em; }
h1 { font-size: clamp(2.5rem, 6vw, 4.5rem); }
h2 { font-size: clamp(1.5rem, 3vw, 2.25rem); }
h3 { font-size: 1.25rem; }

.hero h1 {
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 400;
  letter-spacing: -0.02em;
}

/* Top nav */
.nav {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 56px;
  z-index: 100;
  display: flex; align-items: center; justify-content: center;
  background: rgba(21, 21, 24, 0.7);
  backdrop-filter: saturate(180%) blur(12px);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  border-bottom: 1px solid var(--border);
}
.nav-inner {
  width: 100%; max-width: var(--content-max);
  padding: 0 24px;
  display: flex; align-items: center; justify-content: space-between;
}
.nav-brand {
  display: inline-flex; align-items: center; gap: 8px;
  color: var(--text); font-weight: 600; font-size: 15px;
}
.nav-brand img { width: 20px; height: 20px; }
.nav-right { display: flex; align-items: center; gap: 16px; }
.nav-link {
  color: rgba(255,255,255,0.6); font-size: 13px; font-weight: 500;
  transition: color var(--transition);
}
.nav-link:hover, .nav-link[aria-current="page"] { color: var(--text); }

.cta {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--accent); color: #000;
  padding: 8px 14px; border-radius: 999px;
  font-family: var(--font-mono); font-size: 12px; font-weight: 600;
  transition: opacity var(--transition);
}
.cta:hover { opacity: 0.9; }
.cta-ghost {
  background: transparent; color: var(--text);
  border: 1px solid var(--border);
}

/* Layout containers */
main { padding-top: 56px; }
.section {
  width: 100%; max-width: var(--content-max);
  margin: 0 auto; padding: 80px 24px;
}
.section-narrow {
  max-width: 720px;
}
.eyebrow {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--accent); text-transform: uppercase;
  letter-spacing: 0.15em; margin-bottom: 16px;
}

/* Card grid */
.grid {
  display: grid; gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 24px;
  transition: border-color var(--transition);
}
.card:hover { border-color: rgba(217, 119, 87, 0.4); }
.card h3 { margin-bottom: 8px; }
.card p { color: var(--muted); margin: 0; }

/* Service tile */
.service-tile {
  display: flex; flex-direction: column; gap: 12px;
  color: var(--text);
}
.service-tile-head {
  display: flex; align-items: center; gap: 10px;
}
.service-tile-icon { font-size: 24px; }
.service-tile-name { font-weight: 600; }
.auth-badge {
  font-family: var(--font-mono); font-size: 10px;
  color: var(--muted);
  border: 1px solid var(--border);
  padding: 2px 8px; border-radius: 999px;
}
.service-tile p { font-size: 14px; }

/* FAQ */
.faq details {
  border-top: 1px solid var(--border);
  padding: 16px 0;
}
.faq details:last-child { border-bottom: 1px solid var(--border); }
.faq summary {
  cursor: pointer; font-weight: 500; list-style: none;
  display: flex; justify-content: space-between; align-items: center;
}
.faq summary::after { content: "+"; color: var(--muted); font-size: 18px; }
.faq details[open] summary::after { content: "−"; }
.faq details > p { color: var(--muted); margin: 12px 0 0; }

/* Hero */
.hero {
  text-align: center;
  padding: 120px 24px 60px;
  max-width: 900px; margin: 0 auto;
}
.hero p.tagline {
  font-size: 18px; color: var(--muted); margin: 0 0 32px;
}
.hero-ctas {
  display: inline-flex; gap: 12px; flex-wrap: wrap; justify-content: center;
}

/* Animated terminal */
.term {
  max-width: 880px; margin: 40px auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 20px 80px rgba(0,0,0,0.5);
}
.term-bar {
  background: rgba(255,255,255,0.04);
  padding: 8px 14px; display: flex; gap: 6px;
  border-bottom: 1px solid var(--border);
}
.term-dot { width: 12px; height: 12px; border-radius: 50%; background: rgba(255,255,255,0.15); }
.term-body {
  padding: 20px 24px;
  font-family: var(--font-mono); font-size: 13px; line-height: 1.7;
  min-height: 240px;
  color: var(--text);
}
.term-body .prompt { color: var(--accent); }
.term-body .dim { color: var(--muted); }
@media (prefers-reduced-motion: reduce) {
  .term-cursor { display: none; }
}

/* Footer */
.footer {
  border-top: 1px solid var(--border);
  padding: 40px 24px;
  margin-top: 80px;
}
.footer-inner {
  width: 100%; max-width: var(--content-max);
  margin: 0 auto;
  display: flex; flex-wrap: wrap; gap: 24px; justify-content: space-between;
  font-size: 13px; color: var(--muted);
}
.footer-links { display: flex; gap: 20px; flex-wrap: wrap; }
.footer-links a { color: var(--muted); }
.footer-links a:hover { color: var(--text); }

/* Service page */
.svc-hero { padding: 100px 24px 40px; max-width: 720px; margin: 0 auto; text-align: center; }
.svc-hero .auth-badge { display: inline-block; margin-bottom: 16px; }
.svc-section { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
.svc-section h2 { margin-top: 1em; }
.svc-section ul { padding-left: 1.5em; }
.svc-section li { margin-bottom: 8px; color: var(--muted); }
.svc-section li::marker { color: var(--accent); }

/* Command reference */
.cmd-list { list-style: none; padding: 0; }
.cmd-list li {
  border-top: 1px solid var(--border);
  padding: 16px 0;
}
.cmd-list li:last-child { border-bottom: 1px solid var(--border); }
.cmd-name { font-family: var(--font-mono); font-size: 14px; color: var(--text); }
.cmd-desc { color: var(--muted); font-size: 14px; margin-top: 4px; }
.cmd-opts { margin-top: 8px; font-size: 13px; color: var(--muted); }
.cmd-opts code { font-size: 12px; }

/* Changelog */
.release {
  border-top: 1px solid var(--border);
  padding: 32px 0;
}
.release-head {
  display: flex; align-items: baseline; gap: 16px; margin-bottom: 16px;
}
.release-version { font-family: var(--font-display); font-style: italic; font-size: 28px; }
.release-date { color: var(--muted); font-size: 13px; font-family: var(--font-mono); }
.release-group h3 {
  font-size: 13px; text-transform: uppercase; letter-spacing: 0.15em;
  color: var(--accent); margin-top: 24px;
}
.release-list { list-style: none; padding: 0; }
.release-list li { padding: 6px 0; color: var(--text); }
.release-scope {
  display: inline-block;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 4px; padding: 1px 6px; margin-right: 8px;
  font-family: var(--font-mono); font-size: 11px; color: var(--accent);
}
.release-sha { color: var(--muted); font-family: var(--font-mono); font-size: 12px; margin-left: 8px; }

@media (max-width: 640px) {
  .nav-inner { padding: 0 16px; }
  .section { padding: 60px 16px; }
}
```

- [ ] **Step 2: Commit**

```bash
git add site/src/styles.css
git commit -m "feat(site): add design tokens and base styles"
```

---

## Task 4: Layout template — `_layout.html`

**Files:**
- Create: `site/src/_layout.html`

- [ ] **Step 1: Write the shared layout**

Build script will substitute `{{title}}`, `{{description}}`, `{{slot}}`, and `{{nav_services}}`.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{title}}</title>
    <meta name="description" content="{{description}}">
    <meta name="theme-color" content="#151518">

    <!-- Open Graph -->
    <meta property="og:title" content="{{title}}">
    <meta property="og:description" content="{{description}}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://agentio.me{{path}}">
    <meta property="og:site_name" content="agentio">

    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
    <link rel="icon" href="/favicon.ico" sizes="any">

    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">

    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <nav class="nav">
      <div class="nav-inner">
        <a href="/" class="nav-brand">
          <img src="/logo.png" alt="" width="20" height="20">
          agentio
        </a>
        <div class="nav-right">
          <details class="nav-services">
            <summary class="nav-link">Services ▾</summary>
            <div class="nav-services-menu">
              {{nav_services}}
            </div>
          </details>
          <a href="/changelog/" class="nav-link">Changelog</a>
          <a href="https://github.com/plosson/agentio" class="nav-link">GitHub ↗</a>
          <a href="#install" class="cta">curl … | sh</a>
        </div>
      </div>
    </nav>
    <main>
      {{slot}}
    </main>
    <footer class="footer">
      <div class="footer-inner">
        <div>© agentio · MIT</div>
        <div class="footer-links">
          <a href="https://github.com/plosson/agentio">GitHub</a>
          <a href="/changelog/">Changelog</a>
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
        </div>
      </div>
    </footer>
  </body>
</html>
```

- [ ] **Step 2: Add Services dropdown styles to `site/src/styles.css`**

Append to `site/src/styles.css`:

```css
/* Services dropdown in nav */
.nav-services { position: relative; }
.nav-services summary {
  list-style: none; cursor: pointer;
  color: rgba(255,255,255,0.6); font-size: 13px; font-weight: 500;
}
.nav-services summary::-webkit-details-marker { display: none; }
.nav-services[open] summary { color: var(--text); }
.nav-services-menu {
  position: absolute; top: calc(100% + 8px); right: 0;
  min-width: 200px;
  background: rgba(18, 18, 20, 0.98);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  backdrop-filter: saturate(180%) blur(12px);
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 2px;
}
.nav-services-menu a {
  color: rgba(255,255,255,0.7); font-size: 13px;
  padding: 6px 10px; border-radius: 6px;
}
.nav-services-menu a:hover { background: rgba(255,255,255,0.06); color: var(--text); }
```

- [ ] **Step 3: Commit**

```bash
git add site/src/_layout.html site/src/styles.css
git commit -m "feat(site): add shared layout template"
```

---

## Task 5: Renderer — minimal `{{token}}` substitution + writeHtml helper

**Files:**
- Create: `scripts/build-site/render.ts`
- Create: `scripts/build-site/__tests__/render.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// scripts/build-site/__tests__/render.test.ts
import { describe, it, expect } from 'bun:test';
import { renderTemplate } from '../render';

describe('renderTemplate', () => {
  it('substitutes single token', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('substitutes multiple tokens', () => {
    expect(renderTemplate('{{a}} and {{b}}', { a: '1', b: '2' })).toBe('1 and 2');
  });

  it('leaves unknown tokens untouched', () => {
    expect(renderTemplate('Hello {{unknown}}', {})).toBe('Hello {{unknown}}');
  });

  it('handles repeated tokens', () => {
    expect(renderTemplate('{{x}}-{{x}}', { x: 'y' })).toBe('y-y');
  });

  it('does not interpret HTML in values (caller is responsible)', () => {
    expect(renderTemplate('{{x}}', { x: '<script>' })).toBe('<script>');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun test scripts/build-site/__tests__/render.test.ts`
Expected: FAIL — `Cannot find module '../render'`.

- [ ] **Step 3: Implement `renderTemplate`**

```typescript
// scripts/build-site/render.ts
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type TemplateValues = Record<string, string>;

/**
 * Replace every `{{key}}` occurrence in `template` with `values[key]`.
 * Unknown tokens are left as-is so build errors surface visibly in output.
 * Values are inserted verbatim — escape HTML at the call site if needed.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

/**
 * Render a body fragment into the shared layout, then write to dist.
 */
export async function writePage(
  distRoot: string,
  outPath: string,
  layout: string,
  values: TemplateValues,
): Promise<void> {
  const html = renderTemplate(layout, values);
  const fullPath = join(distRoot, outPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await Bun.write(fullPath, html);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun test scripts/build-site/__tests__/render.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site/render.ts scripts/build-site/__tests__/render.test.ts
git commit -m "feat(site): add minimal {{token}} template renderer"
```

---

## Task 6: Wire the build script to render a placeholder homepage

**Files:**
- Modify: `scripts/build-site.ts`
- Create: `site/src/index.html` (placeholder body)

- [ ] **Step 1: Create a placeholder homepage body**

This will be filled in fully in later tasks. For now it's just enough HTML to confirm the layout and styles load.

```html
<!-- site/src/index.html -->
<section class="hero">
  <h1>agentio</h1>
  <p class="tagline">A CLI for LLM agent workflows. Real services, encrypted vault, MCP, daemon, schedule.</p>
  <div class="hero-ctas">
    <a href="#install" class="cta">curl -LsSf https://agentio.me/install | sh</a>
    <a href="https://github.com/plosson/agentio" class="cta cta-ghost">View on GitHub</a>
  </div>
</section>
```

- [ ] **Step 2: Update the build script to render it**

Replace `scripts/build-site.ts` with:

```typescript
// scripts/build-site.ts
import { rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writePage } from './build-site/render';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const SRC = `${REPO_ROOT}site/src`;
const PUBLIC = `${REPO_ROOT}site/public`;
const DIST = `${REPO_ROOT}site/dist`;

async function main(): Promise<void> {
  console.log('build-site: starting');

  // Clean dist
  await rm(DIST, { recursive: true, force: true });

  // Load layout + styles
  const layout = await Bun.file(`${SRC}/_layout.html`).text();
  const indexBody = await Bun.file(`${SRC}/index.html`).text();
  const styles = await Bun.file(`${SRC}/styles.css`).text();

  // Render homepage
  await writePage(DIST, 'index.html', layout, {
    title: 'agentio — CLI for LLM agent workflows',
    description: 'Run LLM agents against Gmail, Slack, JIRA, WhatsApp, and 14 more. MCP server, daemon, encrypted vault, GitHub Actions ready.',
    path: '/',
    nav_services: '<!-- TODO: populated in later task -->',
    slot: indexBody,
  });

  // Write styles.css to dist root
  await Bun.write(`${DIST}/styles.css`, styles);

  // Copy public assets if directory exists
  if (existsSync(PUBLIC)) {
    await cp(PUBLIC, DIST, { recursive: true });
  }

  console.log('build-site: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Run the build**

Run: `bun run build:site`
Expected:
```
build-site: starting
build-site: done
```
And `site/dist/index.html` + `site/dist/styles.css` exist.

- [ ] **Step 4: Eyeball-test it**

Run: `cd site/dist && python3 -m http.server 8000 &` (or any static server). Open `http://localhost:8000/` — should show the hero with dark background, coral CTA, Instrument Serif headline. Kill the server when done.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site.ts site/src/index.html
git commit -m "feat(site): render placeholder homepage through layout"
```

---

## Task 7: Frontmatter validation wrapper

**Files:**
- Create: `scripts/build-site/frontmatter.ts`
- Create: `scripts/build-site/__tests__/frontmatter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// scripts/build-site/__tests__/frontmatter.test.ts
import { describe, it, expect } from 'bun:test';
import { parseServiceFrontmatter } from '../frontmatter';

describe('parseServiceFrontmatter', () => {
  it('parses valid service frontmatter', () => {
    const md = `---
name: Gmail
slug: gmail
auth: OAuth
tagline: Read and send mail.
icon: 📧
order: 1
---

## What you can do
- thing
`;
    const result = parseServiceFrontmatter(md, 'gmail.md');
    expect(result.meta.name).toBe('Gmail');
    expect(result.meta.slug).toBe('gmail');
    expect(result.meta.auth).toBe('OAuth');
    expect(result.meta.icon).toBe('📧');
    expect(result.meta.order).toBe(1);
    expect(result.body).toContain('## What you can do');
  });

  it('throws when slug is missing', () => {
    const md = `---
name: Gmail
auth: OAuth
tagline: x
icon: 📧
---
`;
    expect(() => parseServiceFrontmatter(md, 'gmail.md')).toThrow(/missing required field 'slug'/);
  });

  it('throws when name is missing', () => {
    const md = `---
slug: gmail
auth: OAuth
tagline: x
icon: 📧
---
`;
    expect(() => parseServiceFrontmatter(md, 'gmail.md')).toThrow(/missing required field 'name'/);
  });

  it('defaults order to 999 when missing', () => {
    const md = `---
name: Gmail
slug: gmail
auth: OAuth
tagline: x
icon: 📧
---
`;
    const result = parseServiceFrontmatter(md, 'gmail.md');
    expect(result.meta.order).toBe(999);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test scripts/build-site/__tests__/frontmatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wrapper**

```typescript
// scripts/build-site/frontmatter.ts
import matter from 'gray-matter';

export interface ServiceMeta {
  name: string;
  slug: string;
  auth: string;
  tagline: string;
  icon: string;
  order: number;
}

export interface ParsedService {
  meta: ServiceMeta;
  body: string;
}

const REQUIRED: Array<keyof ServiceMeta> = ['name', 'slug', 'auth', 'tagline', 'icon'];

export function parseServiceFrontmatter(raw: string, sourcePath: string): ParsedService {
  const parsed = matter(raw);
  const data = parsed.data as Partial<ServiceMeta>;

  for (const key of REQUIRED) {
    if (data[key] === undefined || data[key] === '') {
      throw new Error(`${sourcePath}: missing required field '${key}' in frontmatter`);
    }
  }

  return {
    meta: {
      name: data.name as string,
      slug: data.slug as string,
      auth: data.auth as string,
      tagline: data.tagline as string,
      icon: data.icon as string,
      order: typeof data.order === 'number' ? data.order : 999,
    },
    body: parsed.content,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test scripts/build-site/__tests__/frontmatter.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site/frontmatter.ts scripts/build-site/__tests__/frontmatter.test.ts
git commit -m "feat(site): add service frontmatter parser with validation"
```

---

## Task 8: Markdown rendering helper using `marked`

**Files:**
- Create: `scripts/build-site/markdown.ts`
- Create: `scripts/build-site/__tests__/markdown.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// scripts/build-site/__tests__/markdown.test.ts
import { describe, it, expect } from 'bun:test';
import { renderMarkdown } from '../markdown';

describe('renderMarkdown', () => {
  it('renders headings', () => {
    expect(renderMarkdown('## Hi')).toContain('<h2');
  });

  it('renders unordered lists', () => {
    const html = renderMarkdown('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
  });

  it('renders fenced code blocks', () => {
    const html = renderMarkdown('```sh\nls\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('ls');
  });

  it('renders inline code', () => {
    expect(renderMarkdown('a `code` thing')).toContain('<code>code</code>');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test scripts/build-site/__tests__/markdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/build-site/markdown.ts
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function renderMarkdown(md: string): string {
  return marked.parse(md, { async: false }) as string;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test scripts/build-site/__tests__/markdown.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site/markdown.ts scripts/build-site/__tests__/markdown.test.ts
git commit -m "feat(site): add markdown render helper"
```

---

## Task 9: Service intro stubs — write 18 markdown files

**Files:**
- Create: `site/src/services/gmail.md`
- Create: `site/src/services/slack.md`
- Create: `site/src/services/telegram.md`
- Create: `site/src/services/gchat.md`
- Create: `site/src/services/whatsapp.md`
- Create: `site/src/services/jira.md`
- Create: `site/src/services/confluence.md`
- Create: `site/src/services/github.md`
- Create: `site/src/services/discourse.md`
- Create: `site/src/services/rss.md`
- Create: `site/src/services/sql.md`
- Create: `site/src/services/gdocs.md`
- Create: `site/src/services/gdrive.md`
- Create: `site/src/services/gsheets.md`
- Create: `site/src/services/gslides.md`
- Create: `site/src/services/gtasks.md`
- Create: `site/src/services/gcal.md`
- Create: `site/src/services/gscript.md`

- [ ] **Step 1: Write Gmail stub**

```markdown
---
name: Gmail
slug: gmail
auth: OAuth
tagline: Read, search, send, label, and export email at scale.
icon: 📧
order: 10
---

## What you can do

- Pull unread threads into structured JSON for an LLM to summarize
- Send drafts and replies, with attachments
- Manage labels and filters declaratively
- Export messages as PDF for archival

## Setup

```sh
agentio gmail profile add
```
```

- [ ] **Step 2: Write Slack stub**

```markdown
---
name: Slack
slug: slack
auth: Webhook
tagline: Post to channels via incoming webhooks.
icon: 💬
order: 20
---

## What you can do

- Post LLM-generated summaries to a Slack channel
- Pipe stdout from another command into a Slack message
- Use named profiles for multiple workspaces

## Setup

```sh
agentio slack profile add
```
```

- [ ] **Step 3: Write Telegram stub**

```markdown
---
name: Telegram
slug: telegram
auth: Bot Token
tagline: Send messages and run a real-time inbox via the daemon.
icon: ✈️
order: 30
---

## What you can do

- Send Markdown/HTML messages from any script
- Pull unread messages from the daemon-managed inbox
- Auto-reply to threads with one CLI call

## Setup

```sh
agentio telegram profile add
```
```

- [ ] **Step 4: Write Google Chat stub**

```markdown
---
name: Google Chat
slug: gchat
auth: Webhook / OAuth
tagline: Post to spaces and read messages from authorized rooms.
icon: 🗨️
order: 40
---

## What you can do

- Post space messages via webhook (zero-setup)
- List spaces and read message history with OAuth
- Classify DMs vs rooms via spaceType

## Setup

```sh
agentio gchat profile add
```
```

- [ ] **Step 5: Write WhatsApp stub**

```markdown
---
name: WhatsApp
slug: whatsapp
auth: QR Pairing
tagline: Real-time messaging and full group management via the daemon.
icon: 📱
order: 50
---

## What you can do

- Pair via QR code, then send text, images, video, audio, and documents
- Manage groups: create, rename, add/remove members, promote admins
- Pull a real-time inbox via the daemon and reply with one command
- Teleport auth state between machines

## Setup

```sh
agentio daemon start
agentio whatsapp profile add
```
```

- [ ] **Step 6: Write JIRA stub**

```markdown
---
name: JIRA
slug: jira
auth: OAuth
tagline: Search issues with JQL, comment, transition.
icon: 🎫
order: 60
---

## What you can do

- Search issues with arbitrary JQL
- Read full issue details including comments
- Post comments and transition issues programmatically

## Setup

```sh
agentio jira profile add
```
```

- [ ] **Step 7: Write Confluence stub**

```markdown
---
name: Confluence
slug: confluence
auth: OAuth
tagline: Read and write Confluence pages.
icon: 📚
order: 65
---

## What you can do

- Read pages, including child pages and attachments
- Create and update pages with Markdown content
- Search across spaces

## Setup

```sh
agentio confluence profile add
```
```

- [ ] **Step 8: Write GitHub stub**

```markdown
---
name: GitHub
slug: github
auth: OAuth / PAT
tagline: Install agentio secrets to a repo for GitHub Actions runs.
icon: 🐙
order: 70
---

## What you can do

- Install `AGENTIO_KEY` and `AGENTIO_CONFIG` as repo secrets in one command
- Drive scheduled agent workflows via GitHub Actions

## Setup

```sh
agentio github profile add
agentio github install <owner/repo>
```
```

- [ ] **Step 9: Write Discourse stub**

```markdown
---
name: Discourse
slug: discourse
auth: API Key
tagline: Read forum topics and categories.
icon: 💭
order: 80
---

## What you can do

- List recent topics in a category
- Read full topic threads
- Enumerate categories

## Setup

```sh
agentio discourse profile add
```
```

- [ ] **Step 10: Write RSS stub**

```markdown
---
name: RSS
slug: rss
auth: None
tagline: Parse arbitrary RSS / Atom feeds.
icon: 📰
order: 90
---

## What you can do

- List articles from any public feed
- Read individual articles by ID
- Inspect feed metadata
- No profile setup needed
```

- [ ] **Step 11: Write SQL stub**

```markdown
---
name: SQL
slug: sql
auth: Connection string
tagline: Run queries against PostgreSQL or MySQL databases.
icon: 🗄️
order: 100
---

## What you can do

- Run ad-hoc SQL with `--limit` for safety
- Output results as table, JSON, or CSV
- Manage multiple connection profiles

## Setup

```sh
agentio sql profile add
```
```

- [ ] **Step 12: Write Google Docs stub**

```markdown
---
name: Google Docs
slug: gdocs
auth: OAuth
tagline: Read and create Docs as Markdown, text, or HTML.
icon: 📄
order: 110
---

## What you can do

- Pull a Doc as Markdown for an LLM to summarize
- Create new Docs from Markdown content
- List recent Docs in your Drive

## Setup

```sh
agentio gdocs profile add
```
```

- [ ] **Step 13: Write Google Drive stub**

```markdown
---
name: Google Drive
slug: gdrive
auth: OAuth
tagline: List, search, download, and upload files.
icon: 💾
order: 120
---

## What you can do

- Search files by name, type, or folder
- Download Drive files (with format conversion for Docs)
- Upload local files into a chosen folder

## Setup

```sh
agentio gdrive profile add
```
```

- [ ] **Step 14: Write Google Sheets stub**

```markdown
---
name: Google Sheets
slug: gsheets
auth: OAuth
tagline: Read and write spreadsheet ranges.
icon: 📊
order: 130
---

## What you can do

- Read a range as JSON for analysis
- Append rows from script output
- Update specific cells programmatically

## Setup

```sh
agentio gsheets profile add
```
```

- [ ] **Step 15: Write Google Slides stub**

```markdown
---
name: Google Slides
slug: gslides
auth: OAuth
tagline: Read and update presentation content.
icon: 🎞️
order: 140
---

## What you can do

- List slides in a deck
- Read slide content as text
- Update slide text from a CLI call

## Setup

```sh
agentio gslides profile add
```
```

- [ ] **Step 16: Write Google Tasks stub**

```markdown
---
name: Google Tasks
slug: gtasks
auth: OAuth
tagline: Manage your task lists.
icon: ✅
order: 150
---

## What you can do

- List your task lists and tasks
- Create, update, and complete tasks
- Sync tasks across devices via Google's API

## Setup

```sh
agentio gtasks profile add
```
```

- [ ] **Step 17: Write Google Calendar stub**

```markdown
---
name: Google Calendar
slug: gcal
auth: OAuth
tagline: Read and create calendar events.
icon: 📅
order: 160
---

## What you can do

- List upcoming events
- Create events from script output
- Search events by date or text

## Setup

```sh
agentio gcal profile add
```
```

- [ ] **Step 18: Write Google Apps Script stub**

```markdown
---
name: Google Apps Script
slug: gscript
auth: OAuth
tagline: Manage and run Apps Script projects.
icon: 📜
order: 170
---

## What you can do

- List your Apps Script projects
- Read and update script source files
- Trigger script executions

## Setup

```sh
agentio gscript profile add
```
```

- [ ] **Step 19: Commit**

```bash
git add site/src/services/
git commit -m "feat(site): add service intro stubs (18 services)"
```

---

## Task 10: Service page generator — load stubs, render template

**Files:**
- Create: `site/src/services/_service.html`
- Create: `scripts/build-site/services.ts`
- Create: `scripts/build-site/__tests__/services.test.ts`
- Modify: `scripts/build-site.ts`

- [ ] **Step 1: Write the per-service template**

```html
<!-- site/src/services/_service.html -->
<section class="svc-hero">
  <div class="auth-badge">{{auth}}</div>
  <h1>{{icon}} {{name}}</h1>
  <p class="tagline">{{tagline}}</p>
</section>

<section class="svc-section">
  {{intro_html}}
</section>

<section class="svc-section">
  <h2>Command reference</h2>
  {{commands_html}}
</section>

<section class="svc-section">
  <h2>MCP tools</h2>
  {{mcp_html}}
</section>

<section class="svc-section">
  <h2>Related changelog entries</h2>
  {{related_html}}
</section>
```

- [ ] **Step 2: Write tests for `loadServices`**

```typescript
// scripts/build-site/__tests__/services.test.ts
import { describe, it, expect } from 'bun:test';
import { loadServices } from '../services';
import { join } from 'node:path';

const FIXTURE_DIR = join(import.meta.dir, '../../../site/src/services');

describe('loadServices', () => {
  it('loads at least the registered services', async () => {
    const services = await loadServices(FIXTURE_DIR);
    expect(services.length).toBeGreaterThanOrEqual(18);
    const slugs = services.map((s) => s.meta.slug);
    expect(slugs).toContain('gmail');
    expect(slugs).toContain('whatsapp');
    expect(slugs).toContain('mcp' /* sanity: MCP isn't a service stub */).toBeFalsy?.();
  });

  it('sorts by order then name', async () => {
    const services = await loadServices(FIXTURE_DIR);
    for (let i = 1; i < services.length; i++) {
      const prev = services[i - 1];
      const cur = services[i];
      const prevKey = `${String(prev.meta.order).padStart(4, '0')}-${prev.meta.name}`;
      const curKey = `${String(cur.meta.order).padStart(4, '0')}-${cur.meta.name}`;
      expect(prevKey <= curKey).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `bun test scripts/build-site/__tests__/services.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `loadServices`**

```typescript
// scripts/build-site/services.ts
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseServiceFrontmatter, type ParsedService } from './frontmatter';

export async function loadServices(dir: string): Promise<ParsedService[]> {
  const files = await readdir(dir);
  const mdFiles = files.filter((f) => f.endsWith('.md') && !f.startsWith('_'));

  const services: ParsedService[] = [];
  for (const file of mdFiles) {
    const raw = await Bun.file(join(dir, file)).text();
    services.push(parseServiceFrontmatter(raw, file));
  }

  services.sort((a, b) => {
    if (a.meta.order !== b.meta.order) return a.meta.order - b.meta.order;
    return a.meta.name.localeCompare(b.meta.name);
  });

  return services;
}
```

- [ ] **Step 5: Run tests to confirm they pass**

Run: `bun test scripts/build-site/__tests__/services.test.ts`
Expected: PASS — 2 tests. (The `.toBeFalsy?.()` line in the first test is harmless; remove the chain if it warns.)

Fix the test to remove the optional-chain chain (the test was structured oddly):

```typescript
  it('loads at least the registered services', async () => {
    const services = await loadServices(FIXTURE_DIR);
    expect(services.length).toBeGreaterThanOrEqual(18);
    const slugs = services.map((s) => s.meta.slug);
    expect(slugs).toContain('gmail');
    expect(slugs).toContain('whatsapp');
    expect(slugs).not.toContain('mcp');
  });
```

Re-run tests.

- [ ] **Step 6: Wire build script to render service pages**

Modify `scripts/build-site.ts`. Replace the body of `main()` to add service page rendering:

```typescript
import { rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writePage } from './build-site/render';
import { loadServices } from './build-site/services';
import { renderMarkdown } from './build-site/markdown';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const SRC = `${REPO_ROOT}site/src`;
const PUBLIC = `${REPO_ROOT}site/public`;
const DIST = `${REPO_ROOT}site/dist`;

async function main(): Promise<void> {
  console.log('build-site: starting');

  await rm(DIST, { recursive: true, force: true });

  const layout = await Bun.file(`${SRC}/_layout.html`).text();
  const indexBody = await Bun.file(`${SRC}/index.html`).text();
  const styles = await Bun.file(`${SRC}/styles.css`).text();
  const serviceTemplate = await Bun.file(`${SRC}/services/_service.html`).text();

  const services = await loadServices(`${SRC}/services`);
  console.log(`build-site: loaded ${services.length} services`);

  // Build nav services menu (used by every page)
  const navServicesHtml = services
    .map((s) => `<a href="/services/${s.meta.slug}/">${s.meta.name}</a>`)
    .join('');

  // Render homepage
  await writePage(DIST, 'index.html', layout, {
    title: 'agentio — CLI for LLM agent workflows',
    description: 'Run LLM agents against Gmail, Slack, JIRA, WhatsApp, and 14 more. MCP server, daemon, encrypted vault, GitHub Actions ready.',
    path: '/',
    nav_services: navServicesHtml,
    slot: indexBody,
  });

  // Render each service page
  for (const svc of services) {
    const introHtml = renderMarkdown(svc.body);
    const body = serviceTemplate
      .replaceAll('{{auth}}', svc.meta.auth)
      .replaceAll('{{icon}}', svc.meta.icon)
      .replaceAll('{{name}}', svc.meta.name)
      .replaceAll('{{tagline}}', svc.meta.tagline)
      .replaceAll('{{intro_html}}', introHtml)
      .replaceAll('{{commands_html}}', '<p class="dim">Generated in next task.</p>')
      .replaceAll('{{mcp_html}}', '<p class="dim">Generated in next task.</p>')
      .replaceAll('{{related_html}}', '<p class="dim">Generated in next task.</p>');

    await writePage(DIST, `services/${svc.meta.slug}/index.html`, layout, {
      title: `${svc.meta.name} · agentio`,
      description: svc.meta.tagline,
      path: `/services/${svc.meta.slug}/`,
      nav_services: navServicesHtml,
      slot: body,
    });
  }

  // Write styles
  await Bun.write(`${DIST}/styles.css`, styles);

  // Copy public assets if directory exists
  if (existsSync(PUBLIC)) {
    await cp(PUBLIC, DIST, { recursive: true });
  }

  console.log('build-site: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 7: Build and verify**

Run: `bun run build:site`
Expected: `build-site: loaded 18 services` and 18 directories under `site/dist/services/`.

Run: `ls site/dist/services/` — confirm 18 entries.

- [ ] **Step 8: Eyeball-test one service page**

Start a static server in `site/dist/` and open `http://localhost:8000/services/gmail/`. Should show the service hero with auth badge, icon, name, tagline, and the rendered "What you can do" + "Setup" sections.

- [ ] **Step 9: Commit**

```bash
git add site/src/services/_service.html scripts/build-site.ts scripts/build-site/services.ts scripts/build-site/__tests__/services.test.ts
git commit -m "feat(site): render per-service pages from frontmatter stubs"
```

---

## Task 11: Command reference auto-generation

**Files:**
- Create: `scripts/build-site/commands.ts`
- Create: `scripts/build-site/__tests__/commands.test.ts`
- Modify: `scripts/build-site.ts`

- [ ] **Step 1: Write tests**

```typescript
// scripts/build-site/__tests__/commands.test.ts
import { describe, it, expect } from 'bun:test';
import { renderCommandsHtml } from '../commands';

describe('renderCommandsHtml', () => {
  it('renders nothing for empty service', () => {
    const html = renderCommandsHtml('nonexistent-service');
    expect(html).toContain('No commands');
  });

  it('renders gmail commands', () => {
    const html = renderCommandsHtml('gmail');
    expect(html).toContain('agentio gmail');
    expect(html).toContain('<ul');
  });

  it('escapes HTML in command descriptions', () => {
    // Trust marked elsewhere; this just ensures we don't blindly inject
    const html = renderCommandsHtml('gmail');
    expect(html).not.toContain('<script>');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `bun test scripts/build-site/__tests__/commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/build-site/commands.ts
import { Command } from 'commander';
import { collectCommands, type CommandInfo } from '../../src/utils/command-tree';
import { registerAllCommands } from './register-all';

let cachedCommands: CommandInfo[] | null = null;

function getCommands(): CommandInfo[] {
  if (cachedCommands) return cachedCommands;
  const program = new Command();
  program.name('agentio');
  registerAllCommands(program);
  cachedCommands = collectCommands(program, 'agentio');
  return cachedCommands;
}

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderCommandsHtml(slug: string): string {
  const all = getCommands();
  const cmds = all.filter((cmd) => {
    const parts = cmd.fullPath.split(' ');
    if (parts[1] !== slug) return false;
    if (cmd.fullPath.includes(' profile ')) return false;
    return true;
  });

  if (cmds.length === 0) {
    return '<p class="dim">No commands registered for this service.</p>';
  }

  const items = cmds.map((cmd) => {
    const fullCommand = cmd.arguments.length
      ? `${cmd.fullPath} ${cmd.arguments.join(' ')}`
      : cmd.fullPath;
    const optsHtml = cmd.options.length
      ? `<div class="cmd-opts">${cmd.options.map((o) => `<code>${escape(o.flags)}</code>`).join(' ')}</div>`
      : '';
    return `<li>
      <div class="cmd-name">${escape(fullCommand)}</div>
      ${cmd.description ? `<div class="cmd-desc">${escape(cmd.description)}</div>` : ''}
      ${optsHtml}
    </li>`;
  }).join('');

  return `<ul class="cmd-list">${items}</ul>`;
}
```

- [ ] **Step 4: Create `register-all.ts` to centralize the import list and the canonical slug list**

```typescript
// scripts/build-site/register-all.ts
import type { Command } from 'commander';

import { registerConfluenceCommands } from '../../src/commands/confluence';
import { registerDiscourseCommands } from '../../src/commands/discourse';
import { registerGCalCommands } from '../../src/commands/gcal';
import { registerGChatCommands } from '../../src/commands/gchat';
import { registerGDocsCommands } from '../../src/commands/gdocs';
import { registerGDriveCommands } from '../../src/commands/gdrive';
import { registerGitHubCommands } from '../../src/commands/github';
import { registerGmailCommands } from '../../src/commands/gmail';
import { registerGScriptCommands } from '../../src/commands/gscript';
import { registerGSheetsCommands } from '../../src/commands/gsheets';
import { registerGSlidesCommands } from '../../src/commands/gslides';
import { registerGTasksCommands } from '../../src/commands/gtasks';
import { registerJiraCommands } from '../../src/commands/jira';
import { registerRssCommands } from '../../src/commands/rss';
import { registerSlackCommands } from '../../src/commands/slack';
import { registerSqlCommands } from '../../src/commands/sql';
import { registerTelegramCommands } from '../../src/commands/telegram';
import { registerWhatsAppCommands } from '../../src/commands/whatsapp';

/** Canonical list of service slugs that must each have a `site/src/services/<slug>.md`. */
export const SERVICE_SLUGS = [
  'confluence',
  'discourse',
  'gcal',
  'gchat',
  'gdocs',
  'gdrive',
  'github',
  'gmail',
  'gscript',
  'gsheets',
  'gslides',
  'gtasks',
  'jira',
  'rss',
  'slack',
  'sql',
  'telegram',
  'whatsapp',
] as const;

export function registerAllCommands(program: Command): void {
  registerConfluenceCommands(program);
  registerDiscourseCommands(program);
  registerGCalCommands(program);
  registerGChatCommands(program);
  registerGDocsCommands(program);
  registerGDriveCommands(program);
  registerGitHubCommands(program);
  registerGmailCommands(program);
  registerGScriptCommands(program);
  registerGSheetsCommands(program);
  registerGSlidesCommands(program);
  registerGTasksCommands(program);
  registerJiraCommands(program);
  registerRssCommands(program);
  registerSlackCommands(program);
  registerSqlCommands(program);
  registerTelegramCommands(program);
  registerWhatsAppCommands(program);
}
```

Note: if any import path doesn't exist, fail fast — that's a real signal the spec needs updating.

- [ ] **Step 4b: Add coverage validation to the build script**

In `scripts/build-site.ts`, immediately after `const services = await loadServices(...)`, add:

```typescript
import { SERVICE_SLUGS } from './build-site/register-all';

// ... after loadServices():
const presentSlugs = new Set(services.map((s) => s.meta.slug));
const missing = SERVICE_SLUGS.filter((slug) => !presentSlugs.has(slug));
if (missing.length > 0) {
  throw new Error(
    `build-site: missing intro stub(s) for service(s): ${missing.join(', ')}.\n` +
    `Create site/src/services/<slug>.md for each.`
  );
}
```

- [ ] **Step 5: Run tests**

Run: `bun test scripts/build-site/__tests__/commands.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Wire into the build pipeline**

In `scripts/build-site.ts`, replace `'<p class="dim">Generated in next task.</p>'` (the commands placeholder) with a call to `renderCommandsHtml(svc.meta.slug)`:

```typescript
import { renderCommandsHtml } from './build-site/commands';
// ...
.replaceAll('{{commands_html}}', renderCommandsHtml(svc.meta.slug))
```

- [ ] **Step 7: Build and eyeball**

Run: `bun run build:site` — confirm no errors.
Open `http://localhost:8000/services/gmail/` — confirm "Command reference" lists `agentio gmail list`, `agentio gmail send`, etc.

- [ ] **Step 8: Commit**

```bash
git add scripts/build-site/commands.ts scripts/build-site/register-all.ts scripts/build-site/__tests__/commands.test.ts scripts/build-site.ts
git commit -m "feat(site): auto-generate command reference per service"
```

---

## Task 12: MCP tools auto-generation

**Files:**
- Create: `scripts/build-site/mcp-tools.ts`
- Create: `scripts/build-site/__tests__/mcp-tools.test.ts`
- Modify: `scripts/build-site.ts`

- [ ] **Step 1: Inspect the MCP tools API**

Read `src/mcp/tools.ts` and `src/mcp/server.ts` to confirm:
- `collectMcpTools(program: Command)` is the export
- `SERVICE_REGISTRATIONS` is a `Record<string, (p: Command) => void>`

If the signatures differ, adjust the test and implementation accordingly.

- [ ] **Step 2: Write tests**

```typescript
// scripts/build-site/__tests__/mcp-tools.test.ts
import { describe, it, expect } from 'bun:test';
import { renderMcpToolsHtml } from '../mcp-tools';

describe('renderMcpToolsHtml', () => {
  it('renders tools for a service exposed via MCP', () => {
    const html = renderMcpToolsHtml('gmail');
    expect(html).toContain('gmail_');
  });

  it('renders "not yet exposed" for unsupported service', () => {
    // confluence is registered as a CLI service but not yet in SERVICE_REGISTRATIONS
    const html = renderMcpToolsHtml('confluence');
    expect(html).toContain('Not yet exposed via MCP');
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

Run: `bun test scripts/build-site/__tests__/mcp-tools.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

```typescript
// scripts/build-site/mcp-tools.ts
import { Command } from 'commander';
import { collectMcpTools } from '../../src/mcp/tools';
import { SERVICE_REGISTRATIONS } from '../../src/mcp/server';

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function renderMcpToolsHtml(slug: string): string {
  const register = SERVICE_REGISTRATIONS[slug];
  if (!register) {
    return '<p class="dim">Not yet exposed via MCP.</p>';
  }

  const program = new Command();
  program.name('agentio');
  register(program);
  const tools = collectMcpTools(program);

  if (tools.length === 0) {
    return '<p class="dim">No MCP tools registered.</p>';
  }

  const items = tools.map((t) => `<li>
    <div class="cmd-name">${escape(t.name)}</div>
    ${t.description ? `<div class="cmd-desc">${escape(t.description)}</div>` : ''}
  </li>`).join('');

  return `<ul class="cmd-list">${items}</ul>`;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test scripts/build-site/__tests__/mcp-tools.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 6: Wire into build script**

In `scripts/build-site.ts`:

```typescript
import { renderMcpToolsHtml } from './build-site/mcp-tools';
// ...
.replaceAll('{{mcp_html}}', renderMcpToolsHtml(svc.meta.slug))
```

- [ ] **Step 7: Build and verify**

Run: `bun run build:site` — no errors.
Open `http://localhost:8000/services/gmail/` — confirm MCP tools section shows `gmail_list`, `gmail_get`, etc.
Open `/services/confluence/` — confirm "Not yet exposed via MCP" message.

- [ ] **Step 8: Commit**

```bash
git add scripts/build-site/mcp-tools.ts scripts/build-site/__tests__/mcp-tools.test.ts scripts/build-site.ts
git commit -m "feat(site): auto-generate MCP tools section per service"
```

---

## Task 13: Git tag + commit reader

**Files:**
- Create: `scripts/build-site/git.ts`
- Create: `scripts/build-site/__tests__/git.test.ts`

- [ ] **Step 1: Write tests against real repo state**

```typescript
// scripts/build-site/__tests__/git.test.ts
import { describe, it, expect } from 'bun:test';
import { listVersionTags, listCommitsBetween } from '../git';

describe('listVersionTags', () => {
  it('returns version tags newest-first', async () => {
    const tags = await listVersionTags();
    expect(tags.length).toBeGreaterThan(0);
    // Should look like { name: 'v1.7.0', date: ISO } — adjust if the repo
    // uses bare numbers like '1.7.0'.
    expect(tags[0].name).toMatch(/^v?\d+\.\d+\.\d+$/);
    // Newer first
    if (tags.length > 1) {
      expect(tags[0].date >= tags[1].date).toBe(true);
    }
  });
});

describe('listCommitsBetween', () => {
  it('returns commits between two refs', async () => {
    const tags = await listVersionTags();
    if (tags.length < 2) return; // skip on shallow histories
    const commits = await listCommitsBetween(tags[1].name, tags[0].name);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]).toHaveProperty('sha');
    expect(commits[0]).toHaveProperty('subject');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `bun test scripts/build-site/__tests__/git.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/build-site/git.ts
import { $ } from 'bun';

export interface VersionTag {
  name: string;
  date: string; // ISO
}

export interface Commit {
  sha: string;     // short
  subject: string;
  body: string;
}

export async function listVersionTags(): Promise<VersionTag[]> {
  const out = await $`git for-each-ref --sort=-creatordate --format=%(refname:short)|%(creatordate:iso-strict) refs/tags`.text();
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, date] = l.split('|');
      return { name, date };
    })
    .filter((t) => /^v?\d+\.\d+\.\d+$/.test(t.name));
}

export async function listCommitsBetween(from: string, to: string): Promise<Commit[]> {
  const out = await $`git log ${from}..${to} --format=%h%x09%s%x09%b%x1e`.text();
  return out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, ...rest] = entry.split('\t');
      return { sha, subject: subject ?? '', body: rest.join('\t') };
    });
}

export async function listCommitsUpTo(ref: string): Promise<Commit[]> {
  const out = await $`git log ${ref} --format=%h%x09%s%x09%b%x1e`.text();
  return out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, subject, ...rest] = entry.split('\t');
      return { sha, subject: subject ?? '', body: rest.join('\t') };
    });
}
```

- [ ] **Step 4: Run tests**

Run: `bun test scripts/build-site/__tests__/git.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site/git.ts scripts/build-site/__tests__/git.test.ts
git commit -m "feat(site): add git tag + commit readers"
```

---

## Task 14: Conventional-commit parser + release grouping

**Files:**
- Create: `scripts/build-site/changelog.ts`
- Create: `scripts/build-site/__tests__/changelog.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// scripts/build-site/__tests__/changelog.test.ts
import { describe, it, expect } from 'bun:test';
import { parseConventional, groupReleases } from '../changelog';

describe('parseConventional', () => {
  it('parses feat with scope', () => {
    expect(parseConventional('feat(gmail): add filters')).toEqual({
      type: 'feat', scope: 'gmail', subject: 'add filters',
    });
  });

  it('parses fix without scope', () => {
    expect(parseConventional('fix: handle null token')).toEqual({
      type: 'fix', scope: undefined, subject: 'handle null token',
    });
  });

  it('returns null for non-conventional commits', () => {
    expect(parseConventional('Random merge commit')).toBeNull();
  });

  it('skips version bump commits', () => {
    expect(parseConventional('chore: bump version to 1.7.0')).toEqual({
      type: 'chore',
      scope: undefined,
      subject: 'bump version to 1.7.0',
      isVersionBump: true,
    });
  });
});

describe('groupReleases', () => {
  it('groups feats and fixes into prominent buckets, others into internal', () => {
    const commits = [
      { sha: 'a1', subject: 'feat(gmail): add filters', body: '' },
      { sha: 'a2', subject: 'fix: handle null', body: '' },
      { sha: 'a3', subject: 'chore: bump version to 1.7.0', body: '' },
      { sha: 'a4', subject: 'docs: update readme', body: '' },
      { sha: 'a5', subject: 'refactor: cleanup', body: '' },
    ];
    const groups = groupReleases(commits);
    expect(groups.features).toHaveLength(1);
    expect(groups.fixes).toHaveLength(1);
    expect(groups.internal).toHaveLength(2); // docs + refactor; version bump dropped
    expect(groups.features[0].scope).toBe('gmail');
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run: `bun test scripts/build-site/__tests__/changelog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement parser + grouping**

```typescript
// scripts/build-site/changelog.ts
import type { Commit } from './git';

export interface ParsedCommit {
  type: string;
  scope?: string;
  subject: string;
  isVersionBump?: boolean;
}

export interface ParsedEntry extends ParsedCommit {
  sha: string;
}

export interface ReleaseGroups {
  features: ParsedEntry[];
  fixes: ParsedEntry[];
  internal: ParsedEntry[];
}

const RE = /^(feat|fix|chore|docs|refactor|test|perf|style|build|ci)(\(([^)]+)\))?: (.+)$/;
const VERSION_BUMP_RE = /^bump version to/i;

export function parseConventional(subject: string): ParsedCommit | null {
  const m = subject.match(RE);
  if (!m) return null;
  const [, type, , scope, rest] = m;
  const result: ParsedCommit = {
    type,
    scope: scope || undefined,
    subject: rest,
  };
  if (type === 'chore' && VERSION_BUMP_RE.test(rest)) {
    result.isVersionBump = true;
  }
  return result;
}

export function groupReleases(commits: Commit[]): ReleaseGroups {
  const features: ParsedEntry[] = [];
  const fixes: ParsedEntry[] = [];
  const internal: ParsedEntry[] = [];

  for (const c of commits) {
    const parsed = parseConventional(c.subject);
    if (!parsed) continue;
    if (parsed.isVersionBump) continue;
    const entry: ParsedEntry = { ...parsed, sha: c.sha };
    if (parsed.type === 'feat') features.push(entry);
    else if (parsed.type === 'fix') fixes.push(entry);
    else internal.push(entry);
  }

  return { features, fixes, internal };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test scripts/build-site/__tests__/changelog.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-site/changelog.ts scripts/build-site/__tests__/changelog.test.ts
git commit -m "feat(site): add conventional commit parser + release grouping"
```

---

## Task 15: Render changelog page

**Files:**
- Create: `site/src/changelog.html`
- Create: `scripts/build-site/changelog-render.ts`
- Create: `scripts/build-site/__tests__/changelog-render.test.ts`
- Modify: `scripts/build-site.ts`

- [ ] **Step 1: Write the changelog page template**

```html
<!-- site/src/changelog.html -->
<section class="section section-narrow">
  <div class="eyebrow">Changelog</div>
  <h1>What's shipping</h1>
  <p class="tagline">Auto-generated from <code>git log</code>. Newer first.</p>
</section>

<section class="section section-narrow">
  {{releases_html}}
</section>
```

- [ ] **Step 2: Write tests for the renderer**

```typescript
// scripts/build-site/__tests__/changelog-render.test.ts
import { describe, it, expect } from 'bun:test';
import { renderRelease } from '../changelog-render';
import type { ReleaseGroups } from '../changelog';

describe('renderRelease', () => {
  const empty: ReleaseGroups = { features: [], fixes: [], internal: [] };

  it('renders version, date, and feature list', () => {
    const groups: ReleaseGroups = {
      features: [{ type: 'feat', scope: 'gmail', subject: 'add filters', sha: 'abc1234' }],
      fixes: [],
      internal: [],
    };
    const html = renderRelease({ name: 'v1.7.0', date: '2026-05-09T00:00:00Z' }, groups);
    expect(html).toContain('v1.7.0');
    expect(html).toContain('add filters');
    expect(html).toContain('gmail');
    expect(html).toContain('abc1234');
  });

  it('collapses internal changes in <details>', () => {
    const groups: ReleaseGroups = {
      features: [],
      fixes: [],
      internal: [{ type: 'docs', subject: 'tweak readme', sha: 'def5678' }],
    };
    const html = renderRelease({ name: 'v1.0.0', date: '2026-01-01T00:00:00Z' }, groups);
    expect(html).toContain('<details');
    expect(html).toContain('Internal changes');
    expect(html).toContain('tweak readme');
  });

  it('omits empty groups', () => {
    const html = renderRelease({ name: 'v1.0.0', date: '2026-01-01T00:00:00Z' }, empty);
    expect(html).not.toContain('Features');
    expect(html).not.toContain('Fixes');
    expect(html).not.toContain('Internal');
  });
});
```

- [ ] **Step 3: Run tests to confirm failure**

Run: `bun test scripts/build-site/__tests__/changelog-render.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement renderer**

```typescript
// scripts/build-site/changelog-render.ts
import type { ReleaseGroups, ParsedEntry } from './changelog';
import type { VersionTag } from './git';

const REPO_URL = 'https://github.com/plosson/agentio';

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function entryLi(e: ParsedEntry): string {
  const scope = e.scope
    ? `<span class="release-scope">${escape(e.scope)}</span>`
    : '';
  return `<li id="${e.sha}-${escape(e.scope || 'all')}-${e.type}">
    ${scope}${escape(e.subject)}
    <a class="release-sha" href="${REPO_URL}/commit/${e.sha}">${e.sha}</a>
  </li>`;
}

function group(label: string, entries: ParsedEntry[]): string {
  if (entries.length === 0) return '';
  return `<div class="release-group">
    <h3>${label}</h3>
    <ul class="release-list">${entries.map(entryLi).join('')}</ul>
  </div>`;
}

export function renderRelease(tag: VersionTag, groups: ReleaseGroups): string {
  const date = new Date(tag.date).toISOString().slice(0, 10);
  const internal = groups.internal.length > 0
    ? `<details class="release-group">
        <summary><h3 style="display:inline">Internal changes</h3></summary>
        <ul class="release-list">${groups.internal.map(entryLi).join('')}</ul>
      </details>`
    : '';
  return `<article class="release" id="${escape(tag.name)}">
    <header class="release-head">
      <span class="release-version">${escape(tag.name)}</span>
      <span class="release-date">${date}</span>
    </header>
    ${group('Features', groups.features)}
    ${group('Fixes', groups.fixes)}
    ${internal}
  </article>`;
}
```

- [ ] **Step 5: Run tests**

Run: `bun test scripts/build-site/__tests__/changelog-render.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Wire into build script**

In `scripts/build-site.ts`, after the homepage render block, add changelog rendering:

```typescript
import { listVersionTags, listCommitsBetween, listCommitsUpTo } from './build-site/git';
import { groupReleases } from './build-site/changelog';
import { renderRelease } from './build-site/changelog-render';

// ... inside main(), after services are loaded
const tags = await listVersionTags();
const releases: string[] = [];
for (let i = 0; i < tags.length; i++) {
  const tag = tags[i];
  const prev = tags[i + 1];
  const commits = prev
    ? await listCommitsBetween(prev.name, tag.name)
    : await listCommitsUpTo(tag.name);
  const groups = groupReleases(commits);
  releases.push(renderRelease(tag, groups));
}

const changelogTemplate = await Bun.file(`${SRC}/changelog.html`).text();
const changelogBody = changelogTemplate.replaceAll('{{releases_html}}', releases.join('\n'));

await writePage(DIST, 'changelog/index.html', layout, {
  title: 'Changelog · agentio',
  description: 'Release history for agentio.',
  path: '/changelog/',
  nav_services: navServicesHtml,
  slot: changelogBody,
});
```

- [ ] **Step 7: Build and eyeball**

Run: `bun run build:site` — should print release count, no errors.
Open `http://localhost:8000/changelog/` — should show all version tags newest-first, with feat/fix groups expanded and internal collapsed.

- [ ] **Step 8: Commit**

```bash
git add site/src/changelog.html scripts/build-site/changelog-render.ts scripts/build-site/__tests__/changelog-render.test.ts scripts/build-site.ts
git commit -m "feat(site): render changelog from git tags"
```

---

## Task 16: Cross-link service pages → changelog

**Files:**
- Create: `scripts/build-site/related.ts`
- Modify: `scripts/build-site.ts`

- [ ] **Step 1: Implement `relatedEntriesHtml`**

```typescript
// scripts/build-site/related.ts
import type { ParsedEntry } from './changelog';

const REPO_URL = 'https://github.com/plosson/agentio';

function escape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Given all parsed feature/fix entries across all releases, render the
 * subset whose scope matches `slug` as a list of links into /changelog/.
 */
export function renderRelatedHtml(slug: string, allEntries: ParsedEntry[]): string {
  const matching = allEntries.filter((e) => e.scope === slug);
  if (matching.length === 0) {
    return '<p class="dim">No changelog entries reference this service yet.</p>';
  }
  const items = matching.slice(0, 20).map((e) => `<li>
    <span class="release-scope">${e.type}</span>
    ${escape(e.subject)}
    <a class="release-sha" href="${REPO_URL}/commit/${e.sha}">${e.sha}</a>
  </li>`).join('');
  return `<ul class="cmd-list">${items}</ul>`;
}
```

- [ ] **Step 2: Wire into build script**

In `scripts/build-site.ts`, accumulate all parsed entries while building the changelog, then pass them into the service render loop:

```typescript
import { renderRelatedHtml } from './build-site/related';

// inside main():
const allEntries: ParsedEntry[] = [];
const releases: string[] = [];
for (let i = 0; i < tags.length; i++) {
  const tag = tags[i];
  const prev = tags[i + 1];
  const commits = prev
    ? await listCommitsBetween(prev.name, tag.name)
    : await listCommitsUpTo(tag.name);
  const groups = groupReleases(commits);
  allEntries.push(...groups.features, ...groups.fixes);
  releases.push(renderRelease(tag, groups));
}

// then in the service render loop:
.replaceAll('{{related_html}}', renderRelatedHtml(svc.meta.slug, allEntries))
```

(Add `import type { ParsedEntry } from './build-site/changelog';` to the imports at the top.)

- [ ] **Step 3: Build and eyeball**

Run: `bun run build:site`.
Open `/services/gmail/` — confirm the "Related changelog entries" section now shows entries with scope `gmail`.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-site/related.ts scripts/build-site.ts
git commit -m "feat(site): cross-link service pages to changelog entries"
```

---

## Task 17: Homepage content — fill in the 11 sections

**Files:**
- Modify: `site/src/index.html`

- [ ] **Step 1: Replace the placeholder index body**

Overwrite `site/src/index.html` with the maximalist homepage. Sections marked `{{services_grid}}`, `{{terminal_html}}` are filled in by the build script in later tasks.

```html
<!-- site/src/index.html -->
<section class="hero">
  <h1>The CLI for LLM agents</h1>
  <p class="tagline">Run agentic workflows against Gmail, Slack, JIRA, WhatsApp, and 14 more — over MCP, in GitHub Actions, or as a daemon. One binary, encrypted vault, no third-party servers.</p>
  <div class="hero-ctas">
    <a href="#install" class="cta">curl -LsSf https://agentio.me/install | sh</a>
    <a href="https://github.com/plosson/agentio" class="cta cta-ghost">View on GitHub</a>
  </div>
</section>

{{terminal_html}}

<section class="section">
  <div class="eyebrow">Why agentio</div>
  <h2>Built for agents, not humans</h2>
  <div class="grid">
    <div class="card">
      <h3>Output shaped for LLMs</h3>
      <p>Every command emits structured, parseable output. JSON when you need it; predictable text otherwise.</p>
    </div>
    <div class="card">
      <h3>Encrypted vault, multi-profile</h3>
      <p>Credentials are AES-256-GCM-encrypted in <code>~/.config/agentio/vault.enc</code>. One binary, many identities per service.</p>
    </div>
    <div class="card">
      <h3>MCP + CLI + Actions</h3>
      <p>Same binary serves a stdio MCP server to Claude Code, an HTTP MCP server with OAuth, and runs unchanged inside GitHub Actions.</p>
    </div>
  </div>
</section>

<section class="section">
  <div class="eyebrow">Services</div>
  <h2>Connect once, automate everywhere</h2>
  <div class="grid">
    {{services_grid}}
  </div>
</section>

<section class="section">
  <div class="eyebrow">MCP integration</div>
  <h2>Drop into Claude Code</h2>
  <p>One command writes a <code>.mcp.json</code> that exposes your selected services as MCP tools. Stdio for local clients; HTTP with OAuth for hosted ones.</p>
  <pre><code>$ agentio mcp install gmail:work slack:team rss
Wrote .mcp.json

MCP server command: agentio mcp serve gmail:work slack:team rss</code></pre>
  <p>For remote deploys: <code>agentio mcp teleport &lt;name&gt;</code> ships an HTTP MCP server to a siteio-managed remote with OAuth, in one command.</p>
</section>

<section class="section">
  <div class="eyebrow">GitHub Actions</div>
  <h2>Schedule agents in CI</h2>
  <pre><code>name: daily-summary
on:
  schedule: [{ cron: '0 9 * * *' }]
jobs:
  summarize:
    runs-on: ubuntu-latest
    steps:
      - uses: oven-sh/setup-bun@v2
      - run: bun add -g agentio
      - env:
          AGENTIO_KEY: ${{ secrets.AGENTIO_KEY }}
          AGENTIO_CONFIG: ${{ secrets.AGENTIO_CONFIG }}
        run: |
          agentio gmail list --query "is:unread" --limit 20 \
            | claude -p "summarize these in 3 bullets" \
            | agentio slack send --channel team-updates</code></pre>
  <p><code>agentio github install &lt;owner/repo&gt;</code> installs the two secrets above for you.</p>
</section>

<section class="section">
  <div class="eyebrow">Daemon &amp; scheduler</div>
  <h2>Real-time, when you need it</h2>
  <p>For services that need a persistent connection (WhatsApp, Telegram inbox) or scheduled runs (folder-watched <code>.run.md</code> files), <code>agentio daemon start</code> runs a single background process. Schedules are host-pinned so Dropbox-synced folders never double-fire.</p>
</section>

<section class="section" id="install">
  <div class="eyebrow">Install</div>
  <h2>One line</h2>
  <p><strong>macOS / Linux</strong></p>
  <pre><code>curl -LsSf https://agentio.me/install | sh</code></pre>
  <p><strong>Windows</strong></p>
  <pre><code>iwr -useb https://agentio.me/install.ps1 | iex</code></pre>
  <p>Update later with <code>agentio update</code>.</p>
</section>

<section class="section section-narrow faq">
  <div class="eyebrow">FAQ</div>
  <h2>Common questions</h2>
  <details><summary>Is agentio free?</summary><p>Yes — MIT-licensed, self-hosted. No accounts, no telemetry.</p></details>
  <details><summary>Where are my credentials stored?</summary><p>In an encrypted vault at <code>~/.config/agentio/vault.enc</code>, AES-256-GCM. The passphrase is machine-bound by default; you can supply one via <code>AGENTIO_PASSPHRASE</code>.</p></details>
  <details><summary>Do I need the daemon?</summary><p>Only for WhatsApp, the Telegram inbox, scheduled <code>.run.md</code> runs, and the HTTP MCP server. Everything else runs as a one-shot CLI invocation.</p></details>
  <details><summary>Can I use it without an LLM?</summary><p>Yes. It's a regular CLI — pipe its output into anything.</p></details>
  <details><summary>How is this different from Zapier?</summary><p>You own the credentials and the workflow definitions. Runs in your CI or on your machine; no third-party servers in the path.</p></details>
</section>
```

- [ ] **Step 2: Add the services-grid generator and terminal placeholder to the build script**

In `scripts/build-site.ts`, before rendering the homepage, build the grid HTML:

```typescript
const servicesGridHtml = services.map((s) => `
  <a class="card service-tile" href="/services/${s.meta.slug}/">
    <div class="service-tile-head">
      <span class="service-tile-icon">${s.meta.icon}</span>
      <span class="service-tile-name">${s.meta.name}</span>
      <span class="auth-badge">${s.meta.auth}</span>
    </div>
    <p>${s.meta.tagline}</p>
  </a>
`).join('');

// Static terminal fallback (animation comes in next task)
const terminalFallbackHtml = `
<section class="section">
  <div class="term">
    <div class="term-bar">
      <span class="term-dot"></span><span class="term-dot"></span><span class="term-dot"></span>
    </div>
    <pre class="term-body" id="hero-term"><span class="prompt">$</span> agentio gmail list --limit 5 --query "is:unread"
<span class="dim">id          from                subject</span>
<span class="dim">────────────────────────────────────────</span>
198a3f      alice@stripe.com    Re: invoice question
198a40      ops@github.com      [Action] CI failed
198a41      newsletter@…        Weekly digest
</pre>
  </div>
</section>`;

// then in the homepage render call:
slot: indexBody
  .replaceAll('{{services_grid}}', servicesGridHtml)
  .replaceAll('{{terminal_html}}', terminalFallbackHtml),
```

- [ ] **Step 3: Build and eyeball**

Run: `bun run build:site`
Open `http://localhost:8000/` — confirm hero, terminal mockup, services grid (18 tiles), MCP/Actions/daemon sections, install, FAQ.

- [ ] **Step 4: Commit**

```bash
git add site/src/index.html scripts/build-site.ts
git commit -m "feat(site): build out maximalist homepage content"
```

---

## Task 18: Animated terminal cycle (JS)

**Files:**
- Modify: `site/src/index.html` (terminal section gets a script tag)
- Modify: `scripts/build-site.ts` (replaces fallback with animated version)

- [ ] **Step 1: Define the frames in the build script**

In `scripts/build-site.ts`, replace the terminal fallback block with:

```typescript
const terminalFrames = [
  {
    cmd: 'agentio gmail list --limit 5 --query "is:unread"',
    output: [
      'id          from                subject',
      '────────────────────────────────────────',
      '198a3f      alice@stripe.com    Re: invoice question',
      '198a40      ops@github.com      [Action] CI failed',
      '198a41      newsletter@…        Weekly digest',
    ],
  },
  {
    cmd: 'agentio whatsapp inbox pull',
    output: [
      '5 messages from 3 conversations',
      '────────────────────────────────',
      'wa-1  Bob (mobile)        "see you at 6?"',
      'wa-2  Family group        [photo]',
      'wa-3  Alice               "did you read the doc?"',
    ],
  },
  {
    cmd: 'agentio mcp serve gmail:work slack:team',
    output: [
      'gmail:work — 28 tools',
      'slack:team — 3 tools',
      'Listening on stdio…',
    ],
  },
  {
    cmd: 'agentio schedule list',
    output: [
      'id              folder                  next run',
      '─────────────────────────────────────────────────',
      'daily-summary   ~/agents/                09:00 (in 3h)',
      'weekly-report   ~/agents/reports/        Mon 09:00',
    ],
  },
];

const terminalHtml = `
<section class="section">
  <div class="term">
    <div class="term-bar">
      <span class="term-dot"></span><span class="term-dot"></span><span class="term-dot"></span>
    </div>
    <pre class="term-body" id="hero-term"></pre>
  </div>
  <script type="module">
    const frames = ${JSON.stringify(terminalFrames)};
    const el = document.getElementById('hero-term');
    if (!el) {} else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const f = frames[0];
      el.innerHTML = '<span class="prompt">$</span> ' + f.cmd + '\\n' + f.output.map(l => '<span class="dim">' + l + '</span>').join('\\n');
    } else {
      let i = 0;
      function show() {
        const f = frames[i % frames.length];
        const lines = ['<span class="prompt">$</span> ' + f.cmd, ...f.output.map(l => '<span class="dim">' + l + '</span>')];
        el.innerHTML = lines.join('\\n');
        i++;
        setTimeout(show, 4000);
      }
      show();
    }
  </script>
</section>`;

// then:
slot: indexBody
  .replaceAll('{{services_grid}}', servicesGridHtml)
  .replaceAll('{{terminal_html}}', terminalHtml),
```

Note the escaped `\\n` inside the JSON — those are literal newlines that become single `\n` in the rendered HTML, which then `<pre>` formats correctly.

- [ ] **Step 2: Build and eyeball**

Run: `bun run build:site`
Open the homepage — terminal should cycle every ~4 s through 4 frames. Set OS-level reduce-motion → reload — first frame should stay static.

- [ ] **Step 3: Commit**

```bash
git add scripts/build-site.ts
git commit -m "feat(site): animate hero terminal across 4 command snippets"
```

---

## Task 19: Privacy + terms pages rewrapped

**Files:**
- Create: `site/src/privacy.html`
- Create: `site/src/terms.html`
- Modify: `scripts/build-site.ts`

- [ ] **Step 1: Copy existing privacy body into new template**

Read current `site/privacy.html`, extract the prose content (everything inside `<body>` minus the existing wrapper), and put it into `site/src/privacy.html`:

```html
<!-- site/src/privacy.html -->
<section class="section section-narrow">
  <h1>Privacy</h1>
  {{copy_existing_privacy_body_here}}
</section>
```

(Replace the placeholder with the actual prose from the current `site/privacy.html`. Use plain `<p>` and `<h2>` tags consistent with the new layout.)

- [ ] **Step 2: Same for terms**

```html
<!-- site/src/terms.html -->
<section class="section section-narrow">
  <h1>Terms</h1>
  {{copy_existing_terms_body_here}}
</section>
```

- [ ] **Step 3: Wire into build script**

In `scripts/build-site.ts`:

```typescript
const privacyBody = await Bun.file(`${SRC}/privacy.html`).text();
await writePage(DIST, 'privacy/index.html', layout, {
  title: 'Privacy · agentio',
  description: 'Privacy policy for agentio.',
  path: '/privacy/',
  nav_services: navServicesHtml,
  slot: privacyBody,
});

const termsBody = await Bun.file(`${SRC}/terms.html`).text();
await writePage(DIST, 'terms/index.html', layout, {
  title: 'Terms · agentio',
  description: 'Terms of service for agentio.',
  path: '/terms/',
  nav_services: navServicesHtml,
  slot: termsBody,
});
```

- [ ] **Step 4: Build and eyeball**

Run: `bun run build:site`
Open `/privacy/` and `/terms/` — both should render with the new layout.

- [ ] **Step 5: Commit**

```bash
git add site/src/privacy.html site/src/terms.html scripts/build-site.ts
git commit -m "feat(site): rewrap privacy + terms pages in new layout"
```

---

## Task 20: Move public assets and delete old static HTML

**Files:**
- Move: `site/install` → `site/public/install`
- Move: `site/install.ps1` → `site/public/install.ps1`
- Move: `site/logo.png` → `site/public/logo.png`
- Delete: `site/index.html`
- Delete: `site/privacy.html`
- Delete: `site/terms.html`

- [ ] **Step 1: Move assets**

```bash
mkdir -p site/public
git mv site/install site/public/install
git mv site/install.ps1 site/public/install.ps1
git mv site/logo.png site/public/logo.png
```

- [ ] **Step 2: Add minimal favicons**

Either copy from logo.png at smaller sizes, or generate quickly:

```bash
# Use ImageMagick or a small Bun script to produce favicons.
# If neither is convenient, check in a 16x16 and 32x32 PNG copy of logo.png.
cp site/public/logo.png site/public/favicon-32.png
cp site/public/logo.png site/public/favicon.ico
```

(The browser handles non-square sources gracefully; replace later with proper favicons if desired.)

- [ ] **Step 3: Delete old static HTML**

```bash
git rm site/index.html site/privacy.html site/terms.html
```

- [ ] **Step 4: Rebuild and verify**

Run: `bun run build:site`
Confirm `site/dist/install`, `site/dist/install.ps1`, `site/dist/logo.png` all exist (copied from `site/public/`).

Open `http://localhost:8000/install` — should serve the install script as text.

- [ ] **Step 5: Commit**

```bash
git add -A site/
git commit -m "refactor(site): move public assets, drop legacy static HTML"
```

---

## Task 21: Update `.github/workflows/deploy-site.yml`

**Files:**
- Modify: `.github/workflows/deploy-site.yml`

- [ ] **Step 1: Read current workflow**

Run: `cat .github/workflows/deploy-site.yml`
Confirm current structure (action versions, secret names).

- [ ] **Step 2: Replace it**

```yaml
name: Deploy site

on:
  push:
    branches: [main]
    paths:
      - 'site/**'
      - 'src/commands/**'
      - 'src/mcp/**'
      - 'scripts/build-site.ts'
      - 'scripts/build-site/**'
      - 'package.json'
      - 'bun.lock'
      - '.github/workflows/deploy-site.yml'
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # required so build-site can read git tags
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.11
      - run: bun install --frozen-lockfile
      - run: bun run build:site
      - run: npx wrangler pages deploy site/dist --project-name=agentio
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 3: Sanity-check the bun version**

The release workflow pins `bun-version: 1.3.11` (per memory). Confirm the same version is used here. If you see a different pin in `release.yml`, match it.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-site.yml
git commit -m "ci(site): rebuild site/dist before deploying to Cloudflare Pages"
```

---

## Task 22: End-to-end smoke test

**Files:** none modified — verification only.

- [ ] **Step 1: Clean rebuild**

```bash
rm -rf site/dist
bun run build:site
```

Expected: no errors. Final line `build-site: done`.

- [ ] **Step 2: Run all tests**

```bash
bun test scripts/build-site
```

Expected: PASS — all suites green.

- [ ] **Step 3: Spot-check generated tree**

```bash
ls site/dist/
ls site/dist/services/ | wc -l        # expect 18
ls site/dist/services/gmail/
ls site/dist/changelog/
```

Expected: each service has `index.html`, plus `index.html`, `changelog/index.html`, `privacy/index.html`, `terms/index.html`, `styles.css`, `logo.png`, `install`, `install.ps1`, `favicon*`.

- [ ] **Step 4: Visual review**

```bash
cd site/dist && python3 -m http.server 8000
```

Open in browser:
- `/` — confirm all 11 sections render, terminal animates, services grid has 18 tiles, FAQ accordion works.
- `/services/gmail/` — confirm hero, intro, command reference, MCP tools, related changelog all populated.
- `/services/confluence/` — confirm "Not yet exposed via MCP" message in MCP section.
- `/changelog/` — confirm releases list, internal-changes accordion collapsed.
- `/privacy/`, `/terms/` — confirm rewrapped content.

Compare side-by-side with vibeisland.app to confirm visual parity (dark, coral accent, Instrument Serif headlines, glassy nav, generous whitespace).

Kill the server.

- [ ] **Step 5: Commit any final touch-ups**

If the visual review revealed small issues (spacing, missing `<title>`, broken link), fix them and commit:

```bash
git add <touched-files>
git commit -m "polish(site): fix <thing> after visual review"
```

If nothing needed fixing, skip the commit step.

---

## Self-review notes

- **Spec coverage:** every section of `2026-05-09-site-rework-design.md` maps to at least one task above (IA → Task 6/10/15/17/19; per-service shape → Task 9/10/11/12/16; build pipeline → Task 1/6/10/15; visual system → Task 3/4/17; animated terminal → Task 18; changelog generation → Task 13/14/15; deploy → Task 21; "build fails on missing service stub" trigger behavior → Task 11 Step 4b).
- **Type consistency:** `ParsedEntry` and `ReleaseGroups` defined once in `changelog.ts`, reused in `changelog-render.ts` and `related.ts`. `ParsedService` from `frontmatter.ts` flows through `services.ts` and the build script. `Commit` and `VersionTag` defined in `git.ts`. `SERVICE_SLUGS` defined once in `register-all.ts` and imported wherever coverage is checked.
- **No placeholders:** every code-changing step contains complete code. The `{{copy_existing_privacy_body_here}}` token in Task 19 is paired with explicit instructions to read the existing file and inline its prose — no guessing required.
- **Frequent commits:** every task ends with a commit; most tasks have a single commit step.
