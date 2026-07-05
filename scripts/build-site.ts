import { rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writePage } from './build-site/render';
import { loadServices } from './build-site/services';
import { renderMarkdown } from './build-site/markdown';
import { renderCommandsHtml } from './build-site/commands';
import { renderMcpToolsHtml } from './build-site/mcp-tools';
import { SERVICE_SLUGS } from './build-site/register-all';
import { listVersionTags, listCommitsBetween, listCommitsUpTo } from './build-site/git';
import { groupReleases, type ParsedEntry } from './build-site/changelog';
import { renderRelease } from './build-site/changelog-render';
import { renderRelatedHtml } from './build-site/related';

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

  const presentSlugs = new Set(services.map((s) => s.meta.slug));
  const missing = SERVICE_SLUGS.filter((slug) => !presentSlugs.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `build-site: missing intro stub(s) for service(s): ${missing.join(', ')}.\n` +
      `Create site/src/services/<slug>.md for each.`
    );
  }

  const navServicesHtml = services
    .map((s) => `<a href="/services/${s.meta.slug}/">${s.meta.name}</a>`)
    .join('');

  const tags = await listVersionTags();
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
  console.log(`build-site: rendered ${releases.length} releases`);

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
    <pre class="term-body" data-hh-terminal></pre>
  </div>
  <script>window.hhTerminalFrames = ${JSON.stringify(terminalFrames)};</script>
  <script src="/hh-terminal.js?v=1" defer></script>
</section>`;

  await writePage(DIST, 'index.html', layout, {
    title: 'agentio — CLI for LLM agent workflows',
    description: 'Run LLM agents against Gmail, Slack, JIRA, WhatsApp, and 14 more. MCP server, daemon, encrypted vault, GitHub Actions ready.',
    path: '/',
    nav_services: navServicesHtml,
    slot: indexBody
      .replaceAll('{{services_grid}}', servicesGridHtml)
      .replaceAll('{{terminal_html}}', terminalHtml),
  });

  for (const svc of services) {
    const introHtml = renderMarkdown(svc.body);
    const body = serviceTemplate
      .replaceAll('{{auth}}', svc.meta.auth)
      .replaceAll('{{icon}}', svc.meta.icon)
      .replaceAll('{{name}}', svc.meta.name)
      .replaceAll('{{tagline}}', svc.meta.tagline)
      .replaceAll('{{intro_html}}', introHtml)
      .replaceAll('{{commands_html}}', renderCommandsHtml(svc.meta.slug))
      .replaceAll('{{mcp_html}}', renderMcpToolsHtml(svc.meta.slug))
      .replaceAll('{{related_html}}', renderRelatedHtml(svc.meta.slug, allEntries));

    await writePage(DIST, `services/${svc.meta.slug}/index.html`, layout, {
      title: `${svc.meta.name} · agentio`,
      description: svc.meta.tagline,
      path: `/services/${svc.meta.slug}/`,
      nav_services: navServicesHtml,
      slot: body,
    });
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


  await Bun.write(`${DIST}/styles.css`, styles);

  if (existsSync(PUBLIC)) {
    await cp(PUBLIC, DIST, { recursive: true });
  }

  console.log('build-site: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
