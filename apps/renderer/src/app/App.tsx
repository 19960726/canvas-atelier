import { useEffect } from 'react';
import { CanvasWorkspace } from '../canvas/CanvasWorkspace';
import { useAppStore } from './app-store';

let hydrationStarted = false;

export function App() {
  const hydratePersistence = useAppStore((state) => state.hydratePersistence);

  useEffect(() => {
    if (hydrationStarted) return;
    hydrationStarted = true;
    void hydratePersistence();
  }, [hydratePersistence]);

  return <CanvasWorkspace />;
}

export function resetAppHydrationForTests(): void {
  hydrationStarted = false;
}
