import { useEffect } from 'react';
import { CanvasWorkspace } from '../canvas/CanvasWorkspace';
import { useAppStore } from './app-store';

let hydrationStarted = false;
let closeFlushUnsubscribe: (() => void) | null = null;

export function App() {
  const flushProjectSave = useAppStore((state) => state.flushProjectSave);
  const hydratePersistence = useAppStore((state) => state.hydratePersistence);
  const initializeKnowledge = useAppStore((state) => state.initializeKnowledge);

  useEffect(() => {
    if (hydrationStarted) return;
    hydrationStarted = true;
    void hydratePersistence();
    void initializeKnowledge();
  }, [hydratePersistence, initializeKnowledge]);

  useEffect(() => {
    if (closeFlushUnsubscribe !== null) return;
    const lifecycle = window.novusDesktop?.lifecycle;
    if (lifecycle === undefined) return;

    closeFlushUnsubscribe = lifecycle.subscribeCloseFlushRequest(async (request) => {
      let ok = false;
      try {
        const state = useAppStore.getState();
        const needsUntitledChoice = state.project.name === '未命名画布' && state.saveStatus !== 'saved';
        if (needsUntitledChoice && lifecycle.chooseCloseDecision !== undefined) {
          const decision = await lifecycle.chooseCloseDecision({
            dirty: true,
            projectName: state.project.name,
            untitled: true,
          });
          if (decision === 'cancel') {
            lifecycle.ackCloseFlush({ cancelled: true, requestId: request.requestId, ok: false });
            return;
          }
          ok = decision === 'discard'
            ? await state.discardPersistence()
            : await state.closePersistence();
        } else {
          ok = await state.closePersistence();
        }
      } catch {
        ok = false;
      }
      lifecycle.ackCloseFlush({ requestId: request.requestId, ok });
    });
  }, []);

  useEffect(() => {
    const handleBlur = () => {
      void flushProjectSave('blur');
    };
    const handleClose = () => {
      void flushProjectSave('close');
    };
    window.addEventListener('blur', handleBlur);
    window.addEventListener('beforeunload', handleClose);
    window.addEventListener('pagehide', handleClose);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('beforeunload', handleClose);
      window.removeEventListener('pagehide', handleClose);
    };
  }, [flushProjectSave]);

  return <CanvasWorkspace />;
}

export function resetAppHydrationForTests(): void {
  hydrationStarted = false;
  closeFlushUnsubscribe?.();
  closeFlushUnsubscribe = null;
}
