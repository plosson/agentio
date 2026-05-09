import { rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writePage } from './build-site/render';
import { loadServices } from './build-site/services';
import { renderMarkdown } from './build-site/markdown';
import { renderCommandsHtml } from './build-site/commands';
import { renderMcpToolsHtml } from './build-site/mcp-tools';
import { SERVICE_SLUGS } from './build-site/register-all';
import { listVersionTags, listCommitsBetween, listCommitsUpTo } from './build-site/git';
import { groupReleases } from './build-site/changelog';
import { renderRelease } from './build-site/changelog-render';

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

  await writePage(DIST, 'index.html', layout, {
    title: 'agentio — CLI for LLM agent workflows',
    description: 'Run LLM agents against Gmail, Slack, JIRA, WhatsApp, and 14 more. MCP server, daemon, encrypted vault, GitHub Actions ready.',
    path: '/',
    nav_services: navServicesHtml,
    slot: indexBody,
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
      .replaceAll('{{related_html}}', '<p class="dim">Generated in next task.</p>');

    await writePage(DIST, `services/${svc.meta.slug}/index.html`, layout, {
      title: `${svc.meta.name} · agentio`,
      description: svc.meta.tagline,
      path: `/services/${svc.meta.slug}/`,
      nav_services: navServicesHtml,
      slot: body,
    });
  }

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
  console.log(`build-site: rendered ${releases.length} releases`);

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
