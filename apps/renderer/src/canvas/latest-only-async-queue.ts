export interface LatestOnlyAsyncQueue<T> {
  enqueue(value: T): Promise<boolean>;
  dispose(): void;
}

/** Coalesce bursts of UI edits before handing one value to a durable worker. */
export function createLatestOnlyAsyncQueue<T>(
  worker: (value: T) => Promise<boolean>,
  delayMs = 120,
): LatestOnlyAsyncQueue<T> {
  let pending: { value: T; resolve: (result: boolean) => void }[] = [];
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let running = false;
  let disposed = false;

  const schedule = (delay: number) => {
    if (timer !== null || disposed) return;
    timer = globalThis.setTimeout(() => {
      timer = null;
      void drain();
    }, delay);
  };

  const drain = async () => {
    if (running || disposed || pending.length === 0) return;
    running = true;
    const batch = pending;
    pending = [];
    const latest = batch[batch.length - 1];
    let result = false;
    if (latest !== undefined) {
      try {
        result = await worker(latest.value);
      } catch {
        result = false;
      }
    }
    batch.forEach(({ resolve }) => resolve(result));
    running = false;
    if (pending.length > 0) schedule(delayMs);
  };

  return {
    enqueue(value) {
      if (disposed) return Promise.resolve(false);
      const wasIdle = !running && pending.length === 0 && timer === null;
      const promise = new Promise<boolean>((resolve) => {
        pending.push({ value, resolve });
      });
      if (wasIdle) {
        // Start the first reorder immediately so the control still feels
        // synchronous; only follow-up moves are debounced while it saves.
        void drain();
      } else {
        schedule(delayMs);
      }
      return promise;
    },
    dispose() {
      disposed = true;
      if (timer !== null) globalThis.clearTimeout(timer);
      timer = null;
      pending.forEach(({ resolve }) => resolve(false));
      pending = [];
    },
  };
}
