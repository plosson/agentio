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
