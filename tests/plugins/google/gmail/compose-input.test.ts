import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliError } from '../../../../src/utils/errors';
import {
  SUBJECT_MAX_LENGTH,
  assertSubjectSane,
  loadComposeSpec,
  resolveComposeText,
} from '../../../../src/plugins/google/gmail/compose-input';

describe('assertSubjectSane', () => {
  test('accepts a normal short subject', () => {
    expect(() => assertSubjectSane('Weekly invoice reminder')).not.toThrow();
  });

  test('rejects absurdly long subjects', () => {
    const subject = 'x'.repeat(SUBJECT_MAX_LENGTH + 1);
    expect(() => assertSubjectSane(subject)).toThrow(CliError);
    try {
      assertSubjectSane(subject);
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('INVALID_PARAMS');
      expect((err as CliError).message).toContain('absurdly long');
    }
  });

  test('rejects subjects with newlines', () => {
    expect(() => assertSubjectSane('Hello\nEOF')).toThrow(/newlines/);
  });

  test('rejects heredoc marker <<', () => {
    expect(() => assertSubjectSane('Hello <<EOF')).toThrow(/heredoc/);
  });

  test('rejects EOF shell crumb', () => {
    expect(() => assertSubjectSane('Report EOF')).toThrow(/EOF/);
  });

  test('rejects agentio gmail shell crumb', () => {
    expect(() => assertSubjectSane('oops agentio gmail draft --to x')).toThrow(/agentio gmail/);
  });
});

describe('loadComposeSpec + resolveComposeText file reads', () => {
  async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'agentio-compose-'));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('reads subject-file and body-file as UTF-8', async () => {
    await withTempDir(async (dir) => {
      const subjectPath = join(dir, 'subject.txt');
      const bodyPath = join(dir, 'body.txt');
      await writeFile(subjectPath, '  Café résumé  \n', 'utf-8');
      await writeFile(bodyPath, 'Line one\nLine two\n', 'utf-8');

      const resolved = await resolveComposeText({
        subjectFile: subjectPath,
        bodyFile: bodyPath,
      });

      expect(resolved.subject).toBe('Café résumé');
      expect(resolved.body).toBe('Line one\nLine two');
      expect(resolved.bodyFromFileOrSpec).toBe(true);
    });
  });

  test('loads --spec JSON and fills missing fields', async () => {
    await withTempDir(async (dir) => {
      const specPath = join(dir, 'draft.json');
      await writeFile(
        specPath,
        JSON.stringify({
          to: 'alice@example.com',
          cc: ['bob@example.com'],
          subject: 'From spec',
          body: 'Spec body',
          attachments: ['./a.pdf'],
          html: true,
        }),
        'utf-8',
      );

      const spec = await loadComposeSpec(specPath);
      expect(spec).toEqual({
        to: ['alice@example.com'],
        cc: ['bob@example.com'],
        bcc: undefined,
        subject: 'From spec',
        body: 'Spec body',
        attachments: ['./a.pdf'],
        html: true,
        replyTo: undefined,
      });

      const resolved = await resolveComposeText({ spec });
      expect(resolved.subject).toBe('From spec');
      expect(resolved.body).toBe('Spec body');
      expect(resolved.bodyFromFileOrSpec).toBe(true);
    });
  });

  test('CLI subject/body override spec; conflicts are rejected', async () => {
    await withTempDir(async (dir) => {
      const subjectPath = join(dir, 'subject.txt');
      await writeFile(subjectPath, 'File subject', 'utf-8');

      await expect(
        resolveComposeText({
          subject: 'Flag subject',
          subjectFile: subjectPath,
        }),
      ).rejects.toThrow(/both --subject and --subject-file/);

      await expect(
        resolveComposeText({
          body: 'Flag body',
          bodyFile: join(dir, 'missing.txt'),
        }),
      ).rejects.toThrow(/both --body and --body-file/);

      const resolved = await resolveComposeText({
        subject: 'Flag wins',
        spec: { subject: 'Spec subject', body: 'Spec body' },
      });
      expect(resolved.subject).toBe('Flag wins');
      expect(resolved.body).toBe('Spec body');
    });
  });

  test('subject guardrail runs for file-sourced subjects', async () => {
    await withTempDir(async (dir) => {
      const subjectPath = join(dir, 'bad-subject.txt');
      await writeFile(subjectPath, 'Hello\nEOF\nagentio gmail draft', 'utf-8');
      await expect(
        resolveComposeText({ subjectFile: subjectPath }),
      ).rejects.toThrow(CliError);
    });
  });

  test('missing files produce clear errors', async () => {
    await expect(
      resolveComposeText({ bodyFile: '/tmp/does-not-exist-agentio-body.txt' }),
    ).rejects.toThrow(/Failed to read body file/);
  });
});
