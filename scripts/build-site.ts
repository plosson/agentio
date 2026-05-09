import { rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
