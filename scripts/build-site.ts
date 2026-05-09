import { rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writePage } from './build-site/render';

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

  await writePage(DIST, 'index.html', layout, {
    title: 'agentio — CLI for LLM agent workflows',
    description: 'Run LLM agents against Gmail, Slack, JIRA, WhatsApp, and 14 more. MCP server, daemon, encrypted vault, GitHub Actions ready.',
    path: '/',
    nav_services: '',
    slot: indexBody,
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
