import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeProfile } from '@agent-canvas/domain';

export const INTERACTION_IDLE_RESTORE_MS = 120;

export interface InteractionQuality {
  disableExpensiveShadows: boolean;
  isInteracting: boolean;
  markInteraction: () => void;
  targetFps: number;
  thumbnailEdge: number;
}

export function useInteractionQuality(profile: RuntimeProfile): InteractionQuality {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isInteracting, setIsInteracting] = useState(false);

  const clearRestoreTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const markInteraction = useCallback(() => {
    clearRestoreTimer();
    setIsInteracting(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setIsInteracting(false);
    }, INTERACTION_IDLE_RESTORE_MS);
  }, [clearRestoreTimer]);

  useEffect(() => clearRestoreTimer, [clearRestoreTimer]);

  return useMemo(() => ({
    disableExpensiveShadows: isInteracting,
    isInteracting,
    markInteraction,
    targetFps: Math.max(profile.targetFps, profile.id === 'legacy-win7' ? 30 : 1),
    thumbnailEdge: isInteracting ? getInteractionThumbnailEdge(profile) : profile.thumbnailEdge,
  }), [isInteracting, markInteraction, profile]);
}

function getInteractionThumbnailEdge(profile: RuntimeProfile): number {
  return Math.max(48, Math.floor(profile.thumbnailEdge * 0.75));
}
