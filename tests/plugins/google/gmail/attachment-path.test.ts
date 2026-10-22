import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { attachmentOutputPaths, safeAttachmentName, FALLBACK_ATTACHMENT_NAME } from '../../../../src/plugins/google/gmail/attachment-path';

const out = '/tmp/agentio-gmail-out';
const inside = (p: string) => dirname(p) === resolve(out);

describe('safeAttachmentName', () => {
  test('keeps an ordinary name', () => {
    expect(safeAttachmentName('Invoice 2026-10.pdf')).toBe('Invoice 2026-10.pdf');
  });

  test('neutralises ../ traversal', () => {
    const name = safeAttachmentName('../../x');
    expect(name).not.toContain('/');
    expect(name.startsWith('.')).toBe(false);
  });

  test('neutralises an absolute path', () => {
    expect(safeAttachmentName('/etc/passwd')).toBe('_etc_passwd');
  });

  test('neutralises backslashes', () => {
    const name = safeAttachmentName('..\\..\\Windows\\evil.dll');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('/');
    expect(name.startsWith('.')).toBe(false);
  });

  for (const raw of ['', '   ', '.', '..', '...', undefined, null, '\u0000\u001f']) {
    test(`falls back for ${JSON.stringify(raw)}`, () => {
      expect(safeAttachmentName(raw)).toBe(FALLBACK_ATTACHMENT_NAME);
    });
  }
});

describe('attachmentOutputPaths', () => {
  test('every hostile name stays directly inside the output directory', () => {
    const paths = attachmentOutputPaths(out, ['../../x', '/etc/passwd', '..\\..\\x', '', '.', '..', '~/.ssh/authorized_keys']);
    for (const p of paths) expect(inside(p)).toBe(true);
  });

  test('deduplicates names, case-insensitively', () => {
    const paths = attachmentOutputPaths(out, ['a.pdf', 'A.pdf', 'a.pdf']);
    expect(paths).toEqual([join(resolve(out), 'a.pdf'), join(resolve(out), 'A (2).pdf'), join(resolve(out), 'a (3).pdf')]);
  });

  test('deduplicates empty names', () => {
    const paths = attachmentOutputPaths(out, ['', undefined, '..']);
    expect(paths).toEqual([
      join(resolve(out), 'attachment'),
      join(resolve(out), 'attachment (2)'),
      join(resolve(out), 'attachment (3)'),
    ]);
  });

  test('writing to the returned paths never touches the parent directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentio-gmail-'));
    try {
      const dir = join(root, 'out');
      mkdirSync(dir);
      for (const p of attachmentOutputPaths(dir, ['../escaped.txt', '../../escaped2.txt', '/tmp/escaped3.txt'])) {
        writeFileSync(p, 'x');
      }
      expect(readdirSync(root)).toEqual(['out']);
      expect(readdirSync(dir).length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
