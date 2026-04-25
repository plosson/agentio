/**
 * Per-key serial queue. Tasks submitted under the same key run strictly in order;
 * tasks under different keys run in parallel. Pattern adapted from claudeclaw's
 * `enqueue()` — required to prevent concurrent `claude --resume <id>` from
 * corrupting the same on-disk session file.
 */
export class SerialQueue<K> {
  private tails: Map<K, Promise<unknown>> = new Map();

  enqueue<T>(key: K, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = previous.then(fn, fn);
    const cleanup = task.catch(() => {}).finally(() => {
      // Only clear the tail if no later task chained onto us.
      if (this.tails.get(key) === cleanup) this.tails.delete(key);
    });
    this.tails.set(key, cleanup);
    return task;
  }

  size(): number {
    return this.tails.size;
  }
}
