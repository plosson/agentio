import { describe, it, expect } from 'bun:test';
import { renderCommandsHtml } from '../commands';

describe('renderCommandsHtml', () => {
  it('renders nothing for empty service', () => {
    const html = renderCommandsHtml('nonexistent-service');
    expect(html).toContain('No commands');
  });

  it('renders gmail commands', () => {
    const html = renderCommandsHtml('gmail');
    expect(html).toContain('agentio gmail');
    expect(html).toContain('<ul');
  });

  it('does not blindly inject script tags', () => {
    const html = renderCommandsHtml('gmail');
    expect(html).not.toContain('<script>');
  });
});
