import { createInterface } from 'readline';

/** Lines of one input, read by one reader, so lines that arrive together are not lost. */
export interface LineReader {
  /** The next non-blank line, or null once the input has closed. */
  next(): Promise<string | null>;
  /** Stop reading, so the input no longer keeps the process alive. */
  close(): void;
}

export function createLineReader(input: NodeJS.ReadableStream): LineReader {
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const lines: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const resolve = waiting.shift();
    if (resolve) resolve(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const resolve of waiting.splice(0)) resolve(null);
  });
  return {
    next() {
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close() {
      rl.close();
    },
  };
}
