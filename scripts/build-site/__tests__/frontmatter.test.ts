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
