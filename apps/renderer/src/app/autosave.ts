export const AUTOSAVE_IDLE_MS = 750;

export type AutosaveFlushReason = 'idle' | 'blur' | 'close' | 'stable-boundary';

export interface AutosaveDraft<TProject> {
  project: TProject;
  revision: number;
}

export interface AutosaveController<TProject> {
  cancel(): void;
  flush(reason: AutosaveFlushReason): Promise<boolean>;
  hasInFlight(): boolean;
  hasPending(): boolean;
  schedule(draft: AutosaveDraft<TProject>): void;
}

interface AutosaveControllerOptions<TProject> {
  commit: (draft: AutosaveDraft<TProject>, reason: AutosaveFlushReason) => Promise<boolean>;
  delayMs?: number;
  isReadOnly?: () => boolean;
}

export function createAutosaveController<TProject>({
  commit,
  delayMs = AUTOSAVE_IDLE_MS,
  isReadOnly = () => false,
}: AutosaveControllerOptions<TProject>): AutosaveController<TProject> {
  let inFlightFlush: Promise<boolean> | null = null;
  let pendingDraft: AutosaveDraft<TProject> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (pendingTimer === null) return;
    clearTimeout(pendingTimer);
    pendingTimer = null;
  };

  const flush = (reason: AutosaveFlushReason): Promise<boolean> => {
    clearTimer();
    if (inFlightFlush !== null) return inFlightFlush;
    const draft = pendingDraft;
    pendingDraft = null;
    if (draft === null || isReadOnly()) return Promise.resolve(false);
    const flushPromise = Promise.resolve(commit(draft, reason))
      .then(async (saved) => {
        if (pendingDraft === null || isReadOnly()) return saved;
        const nextDraft = pendingDraft;
        pendingDraft = null;
        const nextSaved = await commit(nextDraft, reason);
        return saved && nextSaved;
      })
      .finally(() => {
        if (inFlightFlush === flushPromise) inFlightFlush = null;
      });
    inFlightFlush = flushPromise;
    return flushPromise;
  };

  return {
    cancel() {
      clearTimer();
      pendingDraft = null;
    },
    flush,
    hasInFlight() {
      return inFlightFlush !== null;
    },
    hasPending() {
      return pendingDraft !== null;
    },
    schedule(draft) {
      pendingDraft = draft;
      clearTimer();
      pendingTimer = setTimeout(() => {
        void flush('idle');
      }, delayMs);
    },
  };
}
