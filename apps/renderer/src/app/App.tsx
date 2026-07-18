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
      try {
        const state = useAppStore.getState();
        if (state.projectLifecycle === 'untitled') {
          if (lifecycle.chooseCloseDecision === undefined) {
            lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'completed', outcome: 'failed' });
            return;
          }
          const decision = await lifecycle.chooseCloseDecision({
            dirty: state.saveStatus !== 'saved',
            projectName: state.project.name,
            untitled: true,
          });
          if (decision === 'cancel') {
            lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'completed', outcome: 'cancelled' });
            return;
          }
          if (decision === 'discard') {
            const discarded = await state.discardPersistence();
            lifecycle.ackCloseFlush({
              requestId: request.requestId,
              phase: 'completed',
              outcome: discarded ? 'discarded' : 'failed',
            });
            return;
          }
        }
        lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'save_started' });
        const saved = await state.closePersistence();
        lifecycle.ackCloseFlush({
          requestId: request.requestId,
          phase: 'completed',
          outcome: saved ? 'saved' : 'failed',
        });
      } catch {
        lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'completed', outcome: 'failed' });
      }
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
