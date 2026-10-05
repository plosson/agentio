import { createInterface } from 'readline';

/**
 * Ask one question on stderr. Ctrl-D closes the input with no answer and gives
 * back '', so the caller reports a missing answer instead of hanging; Ctrl-C
 * stops, as the shell would. `muted` hides what is typed after the question.
 */
function ask(question: string, muted: boolean): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, ...(muted ? { terminal: true } : {}) });
  let hidden = false;
  if (muted) {
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
      if (!hidden) process.stderr.write(text);
    };
  }

  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      if (muted) process.stderr.write('\n');
      resolve(answer);
    });
    rl.on('close', () => {
      if (answered) return;
      process.stderr.write('\n');
      resolve('');
    });
    rl.on('SIGINT', () => {
      rl.close();
      process.exit(130);
    });
    hidden = muted;
  });
}

/**
 * Prompt the user for input with a question.
 */
export async function prompt(question: string): Promise<string> {
  return (await ask(question, false)).trim();
}

/**
 * Prompt for yes/no confirmation.
 */
export async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} (y/n): `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

/** Everything piped on stdin, unchanged, or null from a terminal or an empty pipe. */
export async function readStdinRaw(): Promise<string | null> {
  // Check if stdin is a TTY (interactive terminal)
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  return Buffer.concat(chunks).toString('utf-8');
}

export async function readStdin(): Promise<string | null> {
  const raw = await readStdinRaw();
  return raw === null ? null : raw.trim();
}

/**
 * Prompt for a value without echoing what is typed, for secrets. The question
 * is written; every keystroke after it is not.
 */
export function promptHidden(question: string): Promise<string> {
  return ask(question, true);
}
