import { describe, it, expect } from 'bun:test';
import { renderCommandsHtml } from '../commands';
import { SERVICE_SLUGS } from '../register-all';
import { SERVICE_REGISTRY } from '../../../src/plugins/registry';

describe('renderCommandsHtml', () => {
  it('uses the shared service registry', () => {
    expect(SERVICE_SLUGS).toEqual(SERVICE_REGISTRY.map(({ id }) => id));
  });

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
