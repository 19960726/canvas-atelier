import { useEffect } from 'react';

interface ReadOnlyWritePromotionOptions {
  readonly projectId: string;
  readonly readOnly: boolean;
  readonly reload: () => Promise<boolean>;
  readonly retryMs: number;
}

export function useReadOnlyWritePromotion(options: ReadOnlyWritePromotionOptions): void {
  const { projectId, readOnly, reload, retryMs } = options;

  useEffect(() => {
    if (!readOnly) return;
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

    const schedule = () => {
      timer = globalThis.setTimeout(() => {
        void attempt();
      }, retryMs);
    };
    const attempt = async () => {
      if (cancelled) return;
      let promoted = false;
      try {
        promoted = await reload();
      } catch {
        promoted = false;
      }
      if (!cancelled && !promoted) schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [projectId, readOnly, reload, retryMs]);
}
