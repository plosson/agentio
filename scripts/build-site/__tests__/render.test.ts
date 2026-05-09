import { describe, it, expect } from 'bun:test';
import { renderTemplate } from '../render';

describe('renderTemplate', () => {
  it('substitutes single token', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('substitutes multiple tokens', () => {
    expect(renderTemplate('{{a}} and {{b}}', { a: '1', b: '2' })).toBe('1 and 2');
  });

  it('leaves unknown tokens untouched', () => {
    expect(renderTemplate('Hello {{unknown}}', {})).toBe('Hello {{unknown}}');
  });

  it('handles repeated tokens', () => {
    expect(renderTemplate('{{x}}-{{x}}', { x: 'y' })).toBe('y-y');
  });

  it('does not interpret HTML in values (caller is responsible)', () => {
    expect(renderTemplate('{{x}}', { x: '<script>' })).toBe('<script>');
  });
});
