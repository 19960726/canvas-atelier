/** Coalesce catalog reads, without retaining failures or publishing stale credentials' results. */
export function createProviderCatalogCache<T>() {
  let cached: { key: string; value: T } | null = null;
  let pending: { key: string; promise: Promise<T> } | null = null;
  return {
    peek: () => cached?.value ?? null,
    clear() { cached = null; pending = null; },
    async read(key: string, load: () => Promise<T>): Promise<T> {
      if (cached?.key === key) return cached.value;
      if (pending?.key === key) return pending.promise;
      const flight = { key, promise: Promise.resolve().then(load) };
      pending = flight;
      try {
        const value = await flight.promise;
        if (pending === flight) cached = { key, value };
        return value;
      } finally {
        if (pending === flight) pending = null;
      }
    },
  };
}
