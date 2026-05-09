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
