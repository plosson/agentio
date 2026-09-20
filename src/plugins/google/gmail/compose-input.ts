import { readFile } from 'fs/promises';
import { CliError } from '../../../utils/errors';

/** Practical upper bound — longer subjects almost always mean shell-quoting garbage. */
export const SUBJECT_MAX_LENGTH = 500;

export interface ComposeSpec {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  attachments?: string[];
  html?: boolean;
  replyTo?: string;
}

/**
 * Reject subjects that look like mangled shell / heredoc / CLI crumbs so we never
 * create garbage Gmail drafts (common agent failure mode when quoting --subject/--body).
 */
export function assertSubjectSane(subject: string): void {
  if (subject.length > SUBJECT_MAX_LENGTH) {
    throw new CliError(
      'INVALID_PARAMS',
      `Subject is absurdly long (${subject.length} chars; max ${SUBJECT_MAX_LENGTH}).`,
      'Pass a short --subject, or use --subject-file / --spec with a UTF-8 file instead of shell-quoting a long string.',
    );
  }

  if (/[\r\n]/.test(subject)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Subject contains newlines (likely shell/heredoc quoting garbage).',
      'Use --subject-file <path> or --spec <path.json> so agents do not shell-quote the subject.',
    );
  }

  if (/<</.test(subject)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Subject contains a heredoc marker (<<). Refusing to create a garbage draft.',
      'Use --subject-file or --spec instead of heredoc/shell quoting for --subject.',
    );
  }

  if (/\bEOF\b/.test(subject)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Subject contains shell crumb "EOF". Refusing to create a garbage draft.',
      'Use --subject-file or --spec instead of heredoc/shell quoting for --subject.',
    );
  }

  if (/agentio\s+gmail/i.test(subject)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Subject contains shell crumb "agentio gmail". Refusing to create a garbage draft.',
      'Use --subject-file or --spec instead of embedding CLI text in --subject.',
    );
  }
}

export async function readUtf8TextFile(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    throw new CliError(
      'INVALID_PARAMS',
      `Failed to read ${label}: ${filePath}`,
      'Check that the file exists and is readable UTF-8 text',
    );
  }
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        throw new CliError(
          'INVALID_PARAMS',
          `Spec field "${field}" must be a string or array of strings`,
        );
      }
      out.push(item);
    }
    return out;
  }
  throw new CliError(
    'INVALID_PARAMS',
    `Spec field "${field}" must be a string or array of strings`,
  );
}

/**
 * Load a compose spec JSON file.
 * Accepted fields: to, cc, bcc, subject, body, attachments|attachment, html, replyTo|reply_to
 */
export async function loadComposeSpec(filePath: string): Promise<ComposeSpec> {
  const raw = await readUtf8TextFile(filePath, 'spec file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid JSON in spec file: ${err instanceof Error ? err.message : String(err)}`,
      'Provide a JSON object with fields like {to, cc, bcc, subject, body, attachments}',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Spec file must contain a JSON object',
      'Example: {"to":["a@b.com"],"subject":"Hi","body":"Hello"}',
    );
  }

  const obj = parsed as Record<string, unknown>;
  const attachments =
    asStringArray(obj.attachments, 'attachments') ??
    asStringArray(obj.attachment, 'attachment');

  const replyTo =
    typeof obj.replyTo === 'string'
      ? obj.replyTo
      : typeof obj.reply_to === 'string'
        ? obj.reply_to
        : undefined;

  if (obj.subject !== undefined && typeof obj.subject !== 'string') {
    throw new CliError('INVALID_PARAMS', 'Spec field "subject" must be a string');
  }
  if (obj.body !== undefined && typeof obj.body !== 'string') {
    throw new CliError('INVALID_PARAMS', 'Spec field "body" must be a string');
  }
  if (obj.html !== undefined && typeof obj.html !== 'boolean') {
    throw new CliError('INVALID_PARAMS', 'Spec field "html" must be a boolean');
  }

  return {
    to: asStringArray(obj.to, 'to'),
    cc: asStringArray(obj.cc, 'cc'),
    bcc: asStringArray(obj.bcc, 'bcc'),
    subject: obj.subject as string | undefined,
    body: obj.body as string | undefined,
    attachments,
    html: obj.html as boolean | undefined,
    replyTo,
  };
}

export interface ResolvedComposeText {
  subject: string | undefined;
  body: string | undefined;
  /** True when body was supplied via --body-file or --spec (skip stdin fallback). */
  bodyFromFileOrSpec: boolean;
}

/**
 * Resolve subject/body from flags, optional files, and optional spec.
 * Does not read stdin — caller handles --body "-" / omit → stdin.
 */
export async function resolveComposeText(options: {
  subject?: string;
  subjectFile?: string;
  body?: string;
  bodyFile?: string;
  spec?: ComposeSpec;
}): Promise<ResolvedComposeText> {
  const spec = options.spec ?? {};

  if (options.subject !== undefined && options.subjectFile) {
    throw new CliError(
      'INVALID_PARAMS',
      'Cannot use both --subject and --subject-file',
      'Prefer --subject-file for agent-written subjects to avoid shell quoting bugs.',
    );
  }
  if (options.body !== undefined && options.bodyFile) {
    throw new CliError(
      'INVALID_PARAMS',
      'Cannot use both --body and --body-file',
      'Prefer --body-file (or --body - for stdin) instead of shell-quoting the body.',
    );
  }

  let subject = options.subject;
  if (options.subjectFile) {
    subject = (await readUtf8TextFile(options.subjectFile, 'subject file')).trim();
  } else if (subject === undefined && spec.subject !== undefined) {
    subject = spec.subject;
  }

  let body = options.body;
  let bodyFromFileOrSpec = false;
  if (options.bodyFile) {
    body = await readUtf8TextFile(options.bodyFile, 'body file');
    // Drop a single trailing newline that editors commonly append.
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    else if (body.endsWith('\n')) body = body.slice(0, -1);
    bodyFromFileOrSpec = true;
  } else if (body === undefined && spec.body !== undefined) {
    body = spec.body;
    bodyFromFileOrSpec = true;
  }

  if (subject !== undefined) {
    assertSubjectSane(subject);
  }

  return { subject, body, bodyFromFileOrSpec };
}
