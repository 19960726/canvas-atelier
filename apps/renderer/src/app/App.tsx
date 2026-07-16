import { useEffect } from 'react';
import { CanvasWorkspace } from '../canvas/CanvasWorkspace';
import { useAppStore } from './app-store';

let hydrationStarted = false;

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
}
