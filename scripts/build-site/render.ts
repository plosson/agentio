import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type TemplateValues = Record<string, string>;

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

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
