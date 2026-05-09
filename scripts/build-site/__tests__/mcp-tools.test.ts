import { describe, it, expect } from 'bun:test';
import { renderMcpToolsHtml } from '../mcp-tools';

describe('renderMcpToolsHtml', () => {
  it('renders tools for a service exposed via MCP', () => {
    const html = renderMcpToolsHtml('gmail');
    expect(html).toContain('gmail_');
  });

  it('renders "not yet exposed" for unsupported service', () => {
    const html = renderMcpToolsHtml('confluence');
    expect(html).toContain('Not yet exposed via MCP');
  });
});
