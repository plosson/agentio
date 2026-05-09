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
    expect(slugs).not.toContain('mcp');
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
