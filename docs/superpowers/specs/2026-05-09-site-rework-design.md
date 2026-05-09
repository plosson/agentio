# Site rework — homepage + per-service pages + changelog

**Date:** 2026-05-09
**Status:** Approved (design)
**Reference style:** https://vibeisland.app/

## Problem

The current `site/index.html` is a single static page that hasn't been touched
in ~3 months while 305 commits have shipped. It still advertises 7 services
when 18 are registered, and it doesn't mention the MCP server, the daemon, the
scheduler, or the encrypted vault — the project's strongest stories. The
maintenance model ("hand-edit one HTML file") is the root cause: feature
commits don't include site updates, so the marketing copy drifts.

## Goals

1. Reposition the site around the project's real surface (services, MCP,
   daemon, scheduler).
2. Make the per-service content **regenerate automatically** when the CLI
   surface changes, so this drift can't happen again.
3. Match the visual style of vibeisland.app (dark, coral accent, generous
   whitespace, Instrument Serif display + JetBrains Mono code).

## Non-goals

- i18n / locale switcher (vibeisland has 4 locales; agentio has zero need).
- Pricing / affiliate / payment integrations (OSS, MIT-licensed).
- Sound effects, custom cursor pixel art (vibeisland-specific charm; would
  feel borrowed).
- Migrating to a SSG framework (Astro/Eleventy). A single Bun script is enough
  for ~20 pages, all sharing one layout.

## Information architecture

| Path                      | Source                                 | Content                                    |
|---------------------------|----------------------------------------|--------------------------------------------|
| `/`                       | `site/src/index.html` (template)       | Maximalist homepage (11 sections, below)   |
| `/changelog/`             | `site/src/changelog.html` + `git log`  | Auto-generated per release                 |
| `/services/<slug>/`       | `site/src/services/<slug>.md` + Commander tree | Per-service page (one per registered service) |
| `/privacy/`               | `site/src/privacy.html`                | Existing copy, rewrapped in new layout     |
| `/terms/`                 | `site/src/terms.html`                  | Existing copy, rewrapped in new layout     |
| `/install`, `/install.ps1`| `site/public/install*`                 | Unchanged, copied verbatim                 |
| `/logo.png`, `/favicon*`  | `site/public/`                         | Static assets                              |

The full set of services is enumerated by importing the same registries the
CLI itself uses — there is no hardcoded service list anywhere in the site.

## Source layout

```
site/
├── src/
│   ├── _layout.html              # shared <head>, nav, footer; {{slot}} for body
│   ├── index.html                # homepage template
│   ├── changelog.html            # changelog page template
│   ├── privacy.html              # legal page (rewrapped)
│   ├── terms.html                # legal page (rewrapped)
│   ├── services/
│   │   ├── _service.html         # per-service page template
│   │   ├── gmail.md              # frontmatter + hand-written body
│   │   └── …                     # one .md per registered service
│   ├── styles.css                # design tokens + components
│   └── assets/                   # logo, screenshots
├── public/                       # copied verbatim into dist/
│   ├── install
│   ├── install.ps1
│   ├── logo.png
│   ├── favicon.ico
│   └── favicon-32.png
└── dist/                         # build output (gitignored, deployed)
```

`scripts/build-site.ts` is the entire build pipeline.

## Per-service content shape

Each `site/src/services/<slug>.md` carries hand-written context only:

```yaml
---
name: Gmail
slug: gmail
auth: OAuth
tagline: Read, search, send, label, and export email at scale.
icon: 📧
order: 1
---

## What you can do

- Pull unread threads into structured JSON for an LLM to summarize
- Send drafts and replies with attachments
- Manage labels and filters declaratively
- Export messages as PDF for archival

## Setup

\`\`\`sh
agentio gmail profile add
\`\`\`
```

The build script appends three auto-generated sections to every service page:

1. **Command reference** — from `collectCommands(program, 'agentio')`
   filtered to the service (same source as `agentio docs --service <name>`).
2. **MCP tools** — from `collectMcpTools` in `src/mcp/tools.ts`. Listed only
   for services present in `SERVICE_REGISTRATIONS`. Services not exposed via
   MCP get a "Not yet exposed via MCP" note.
3. **Related changelog entries** — anchors into `/changelog/` for any commit
   matching `^(feat|fix)\(<slug>\):` since the service first appeared.

## Homepage section flow

1. **Fixed top nav** — wordmark + 16px logo (left); `Services ▾` dropdown ·
   `Changelog` · `GitHub ↗` · primary CTA pill (`curl … | sh` shortened,
   click-to-copy) on the right.
2. **Hero** — Instrument Serif italic headline ("Run LLM agent workflows in
   GitHub Actions" or similar), one-line tagline, primary CTA + secondary
   "View on GitHub".
3. **Animated terminal centerpiece** — single `<pre>` with a JS typewriter
   (~50 lines) cycling 4 scripted snippets every ~4 s. Static fallback for
   `prefers-reduced-motion`.
4. **Why agentio** — 3-card row: "For LLM agents, not humans" · "Multi-profile,
   encrypted vault" · "MCP + CLI + GitHub Actions, one binary".
5. **Supported services grid** — auto-populated from
   `site/src/services/*.md` frontmatter. Tile shows icon + name + auth badge
   + tagline; whole tile links to `/services/<slug>/`. Grid stays in sync
   with the per-service pages because both read the same source.
6. **MCP integration** — short prose + code block: stdio transport via
   `agentio mcp serve`, HTTP transport via `agentio server`, OAuth, and
   `agentio mcp install` writing `.mcp.json` for Claude Code.
7. **GitHub Actions example** — real workflow YAML showing a scheduled agent
   run using agentio. Reinforces the tagline.
8. **Daemon & scheduling** — short prose: persistent connections (WhatsApp,
   Telegram), folder-watched `.run.md` cron, host-pinned schedules.
9. **Install** — `curl -LsSf https://agentio.me/install | sh` (macOS/Linux)
   and `iwr -useb https://agentio.me/install.ps1 | iex` (Windows), plus
   `agentio update` callout.
10. **FAQ** — `<details>` accordion: pricing, credential storage, daemon
    requirement, LLM-optional usage, comparison to Zapier.
11. **Footer** — minimal: GitHub · Changelog · Privacy · Terms · License (MIT).

## Animated terminal — content cycle

Four scripted command snippets, each held for ~4 s before transitioning:

1. `agentio gmail list --limit 5 --query "is:unread"` → 5-line table output
2. `agentio whatsapp inbox pull` → 3 inbox messages
3. `agentio mcp serve gmail:work slack:team` → "Listening on stdio…"
4. `agentio schedule list` → 2 entries, last-run column

Implementation: a single `<pre id="hero-term">` with one `<span class="line">`
per visible line; a small loop (in `<script type="module">` inline in
`index.html`) advances frames. No external animation lib. The fallback
content (statically rendered first frame) is always present so users who block
JS or honor `prefers-reduced-motion` get something legible.

## Changelog generation

Pipeline (in `scripts/build-site.ts`):

1. List version tags chronologically:
   `git for-each-ref --sort=-creatordate --format='%(refname:short)|%(creatordate:iso)' refs/tags`.
2. For each tag, get commits since the previous tag:
   `git log <prev>..<tag> --format='%H%x09%s%x09%b'`.
3. Parse Conventional Commit prefix: `^(feat|fix|chore|docs|refactor|test|perf|style)(\(([^)]+)\))?: (.+)$`.
4. Drop `chore: bump version to X.Y.Z` (the version is already the section
   header).
5. Group per release:
   - **Features** (`feat:`) — prominently listed
   - **Fixes** (`fix:`) — prominently listed
   - **Internal** (`chore:`, `docs:`, `refactor:`, `test:`, `perf:`, `style:`)
     — collapsed in a `<details>` block per release
6. Each line renders as: scope badge (if any) + subject + commit short SHA
   (linking to GitHub).
7. Service pages cross-link to changelog via `id` anchors:
   `/changelog/#1.6.1-feat-gmail-…` etc.

## Build pipeline

Single Bun script: `scripts/build-site.ts`. No framework, no template engine.

```
bun run build:site
  ├── readServiceMarkdowns()         → frontmatter + body for all services
  ├── importCommanderTree()          → collectCommands() per service
  ├── importMcpTools()               → collectMcpTools() filtered per service
  ├── readGitTagsAndCommits()        → grouped releases
  ├── render(_layout, index)         → dist/index.html
  ├── render(_layout, changelog)     → dist/changelog/index.html
  ├── for service of services:
  │     render(_layout, _service)    → dist/services/<slug>/index.html
  ├── render(_layout, privacy/terms) → dist/privacy/, dist/terms/
  └── copy(public/*)                 → dist/*
```

`package.json`:

```json
{
  "scripts": {
    "build:site": "bun scripts/build-site.ts"
  }
}
```

The script uses no external dependencies beyond what the CLI already pulls in.
Markdown rendering uses a minimal inline renderer (~100 LOC) supporting only
the constructs actually used in the service `.md` files: paragraphs,
headings, fenced code blocks, lists, inline code. If `marked` is already a
dep, use it; otherwise hand-roll. (This is a project decision left for the
implementation plan.)

## Visual system

Tokens (single `:root` block in `styles.css`):

```css
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
```

- Body: `--bg` background, `--text` foreground, sans body, mono code.
- Body texture: one inline SVG fractal noise data-URI, opacity 0.03,
  `mix-blend-mode: overlay` — same technique as vibeisland.
- Headings: `--font-display` italic for the hero only; sans elsewhere.
- Code: `--surface` cards, `--border` outline, 8–10 px radius.
- Hover/focus: 160 ms ease, opacity + accent border.
- Top nav: fixed, `backdrop-filter: saturate(180%) blur(12px)`, semi-opaque
  `--bg` background.
- Single coral CTA color (`--accent`), used sparingly — primary buttons only.

## Top nav

```
[logo] agentio                    Services ▾   Changelog   GitHub ↗   [curl … | sh ⎘]
```

Glassy fixed nav, ~56 px tall. The Services dropdown is a small CSS-only
`<details>` menu listing all services (auto-populated from frontmatter,
sorted by `order` then alphabetical).

## FAQ content (homepage)

Hand-written, in the homepage template:

- **Is agentio free?** — Yes, MIT license, self-hosted.
- **Where are my credentials stored?** — Encrypted vault at
  `~/.config/agentio/vault.enc`, AES-256-GCM, machine-bound passphrase.
- **Do I need the daemon?** — Only for WhatsApp, Telegram inbox, scheduled
  `.run.md` runs, and the HTTP MCP server.
- **Can I use it without an LLM?** — Yes; it's a regular CLI.
- **How is this different from Zapier?** — Runs in your CI or locally, no
  third-party servers, you own the credentials and the workflow definitions.

## Deploy

`.github/workflows/deploy-site.yml` (rewritten):

- **Triggers**:
  - `push` to `main` touching `site/**`, `src/commands/**`, `src/mcp/**`,
    `scripts/build-site.ts`, or `package.json`
  - `push` of any `v*` tag (so a release re-renders the changelog)
  - `workflow_dispatch` for manual rebuilds
- **Steps**:
  1. `actions/checkout@v4` with `fetch-depth: 0` (need full git history for
     changelog).
  2. `oven-sh/setup-bun@v2` pinned to the same Bun version used in `release.yml`.
  3. `bun install --frozen-lockfile`
  4. `bun run build:site`
  5. `npx wrangler pages deploy site/dist --project-name=agentio`

## Trigger / drift behavior

- A new service is added → its `register*Commands` is registered in
  `src/index-program.ts` → next deploy includes it on the homepage grid and
  generates `/services/<slug>/`. **A `site/src/services/<slug>.md` stub is
  required** — the build fails with a clear "missing intro for service X"
  error otherwise. This is intentional: a stub takes ~30 seconds to write
  and forces some hand-written context per service.
- A command is added/renamed → next deploy regenerates the command reference
  on the affected service page.
- A new release is tagged → next deploy regenerates `/changelog/`.

## Testing strategy

- `scripts/build-site.test.ts` — golden-file tests for:
  - Service page generation against a fixture Commander tree
  - Changelog grouping with a fixture git history
  - Frontmatter parser
- A CI smoke test that runs `bun run build:site` and `wrangler pages deploy
  --dry-run` against `site/dist/` (no external deploy).
- Manual visual review against vibeisland.app for one homepage and one
  service page before first deploy.

## Open implementation choices (deferred to writing-plans)

1. Use existing `marked` if already a dep, else hand-roll a minimal
   markdown renderer (~100 LOC).
2. Where to host the homepage hero terminal frames (inline JS array vs
   external JSON). Recommend inline.
3. Whether to bundle Instrument Serif as a self-hosted font or keep the
   Google Fonts link (recommend keep Google Fonts; matches vibeisland and
   avoids licensing/hosting overhead).

## Files touched (high-level)

| Action  | Path                                            |
|---------|-------------------------------------------------|
| Create  | `site/src/` (whole tree)                        |
| Create  | `site/public/` (move install scripts + logo here)|
| Delete  | `site/index.html`, `site/privacy.html`, `site/terms.html` (replaced by templates) |
| Move    | `site/install`, `site/install.ps1`, `site/logo.png` → `site/public/` |
| Create  | `scripts/build-site.ts`                         |
| Create  | `scripts/build-site.test.ts`                    |
| Modify  | `package.json` (add `build:site` script)        |
| Modify  | `.gitignore` (add `site/dist/`)                 |
| Modify  | `.github/workflows/deploy-site.yml`             |
