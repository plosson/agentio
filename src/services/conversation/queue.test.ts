import { describe, expect, test } from 'bun:test';
import { SerialQueue } from './queue';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('SerialQueue', () => {
  test('runs tasks for the same key in submission order', async () => {
    const q = new SerialQueue<string>();
    const order: string[] = [];
    const a = deferred<void>();
    const b = deferred<void>();

    const p1 = q.enqueue('chat-1', async () => { await a.promise; order.push('A'); });
    const p2 = q.enqueue('chat-1', async () => { await b.promise; order.push('B'); });

    // Resolve B first, but A was queued first — A still must run first.
    b.resolve(); a.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['A', 'B']);
  });

  test('runs tasks for different keys in parallel', async () => {
    const q = new SerialQueue<string>();
    const a = deferred<void>();
    const b = deferred<void>();

    const p1 = q.enqueue('chat-1', async () => { await a.promise; return 'A'; });
    const p2 = q.enqueue('chat-2', async () => { await b.promise; return 'B'; });

    // Both can be in-flight: resolve B first, p2 finishes before p1.
    b.resolve();
    expect(await p2).toBe('B');
    a.resolve();
    expect(await p1).toBe('A');
  });

  test('a thrown task does not stall the queue for that key', async () => {
    const q = new SerialQueue<string>();
    const p1 = q.enqueue('chat-1', async () => { throw new Error('boom'); });
    const p2 = q.enqueue('chat-1', async () => 'next');
    await expect(p1).rejects.toThrow('boom');
    expect(await p2).toBe('next');
  });

  test('returns task result via the promise', async () => {
    const q = new SerialQueue<string>();
    const result = await q.enqueue('k', async () => 42);
    expect(result).toBe(42);
  });

  test('size() reflects pending keys', async () => {
    const q = new SerialQueue<string>();
    const d = deferred<void>();
    q.enqueue('k', async () => { await d.promise; });
    expect(q.size()).toBe(1);
    d.resolve();
    // Wait one microtask for the chain cleanup.
    await new Promise((r) => setImmediate(r));
    expect(q.size()).toBe(0);
  });
});
