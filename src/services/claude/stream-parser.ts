export type StreamEvent =
  | { kind: 'init'; sessionId: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'result'; text: string };

interface AnyJson { [k: string]: unknown }

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: AnyJson;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
    return { kind: 'init', sessionId: obj.session_id };
  }

  if (obj.type === 'assistant') {
    const msg = obj.message as { content?: Array<{ type: string; text?: string }> } | undefined;
    const blocks = msg?.content ?? [];
    const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text!);
    if (texts.length > 0) return { kind: 'assistant_text', text: texts.join('') };
    return null;
  }

  if (obj.type === 'result' && typeof obj.result === 'string') {
    return { kind: 'result', text: obj.result };
  }

  return null;
}
