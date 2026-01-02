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
