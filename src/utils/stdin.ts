import { createInterface } from 'readline';

/**
 * Prompt the user for input with a question.
 */
export function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const writer = rl as unknown as { _writeToOutput: (text: string) => void };
  let muted = false;
  writer._writeToOutput = (text) => {
    if (!muted) process.stderr.write(text);
  };

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}
