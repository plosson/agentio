import { StringDecoder } from 'string_decoder';

/**
 * One line reader over process.stdin for every prompt in the process. A
 * reader per question buffers past its own line, and piped answers meant for
 * the next questions would be lost with it. Between reads stdin is paused and
 * released, so other readers (a hidden password prompt) see it untouched and
 * the process can exit.
 */
const decoder = new StringDecoder('utf8');
let buffered = '';
let ended = false;
const waiters: Array<(line: string | null) => void> = [];

function onData(chunk: Buffer | string): void {
  buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
  drain();
}

function onEnd(): void {
  buffered += decoder.end();
  ended = true;
  drain();
}

function drain(): void {
  while (waiters.length > 0) {
    const newline = buffered.indexOf('\n');
    if (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '');
      buffered = buffered.slice(newline + 1);
      waiters.shift()!(line);
    } else if (ended) {
      const rest = buffered;
      buffered = '';
      waiters.shift()!(rest || null);
    } else {
      break;
    }
  }
  if (waiters.length === 0) {
    process.stdin.off('data', onData);
    process.stdin.off('end', onEnd);
    process.stdin.pause();
  }
}

/**
 * Read the next line of stdin, or null at end of input. When the signal
 * aborts first the promise stays unsettled and the line goes to the next read.
 */
export function readLine(signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return;
    waiters.push(resolve);
    signal?.addEventListener(
      'abort',
      () => {
        const at = waiters.indexOf(resolve);
        if (at >= 0) waiters.splice(at, 1);
        drain();
      },
      { once: true },
    );
    if (process.stdin.readableEnded) ended = true;
    if (waiters.length === 1 && !ended && !buffered.includes('\n')) {
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.resume();
    }
    drain();
  });
}

/**
 * Prompt the user for input with a question.
 */
export async function prompt(question: string): Promise<string> {
  process.stderr.write(question);
  return ((await readLine()) ?? '').trim();
}

/**
 * Prompt for yes/no confirmation.
 */
export async function confirm(question: string): Promise<boolean> {
  const answer = await prompt(`${question} (y/n): `);
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

export async function readStdin(): Promise<string | null> {
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

  return Buffer.concat(chunks).toString('utf-8').trim();
}
