import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeProfile } from '@agent-canvas/domain';

export const INTERACTION_IDLE_RESTORE_MS = 400;

export interface InteractionQuality {
  disableExpensiveShadows: boolean;
  isInteracting: boolean;
  markInteraction: () => void;
  targetFps: number;
  thumbnailEdge: number;
}

export function useInteractionQuality(profile: RuntimeProfile, keepLargeCanvasLightweight = false): InteractionQuality {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isInteractingRef = useRef(false);
  const keepLargeCanvasLightweightRef = useRef(keepLargeCanvasLightweight);
  keepLargeCanvasLightweightRef.current = keepLargeCanvasLightweight;
  const [isInteracting, setIsInteracting] = useState(false);

  const clearRestoreTimer = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const markInteraction = useCallback(() => {
    clearRestoreTimer();
    if (!isInteractingRef.current) {
      isInteractingRef.current = true;
      if (!keepLargeCanvasLightweightRef.current) setIsInteracting(true);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      isInteractingRef.current = false;
      if (!keepLargeCanvasLightweightRef.current) setIsInteracting(false);
    }, INTERACTION_IDLE_RESTORE_MS);
  }, [clearRestoreTimer]);

  useEffect(() => clearRestoreTimer, [clearRestoreTimer]);
  useEffect(() => {
    if (!keepLargeCanvasLightweight && !isInteractingRef.current) setIsInteracting(false);
  }, [keepLargeCanvasLightweight]);

  return useMemo(() => ({
    disableExpensiveShadows: isInteracting || keepLargeCanvasLightweight,
    get isInteracting() { return isInteractingRef.current; },
    markInteraction,
    targetFps: Math.max(profile.targetFps, profile.id === 'legacy-win7' ? 30 : 1),
    thumbnailEdge: isInteracting || keepLargeCanvasLightweight ? getInteractionThumbnailEdge(profile) : profile.thumbnailEdge,
  }), [isInteracting, keepLargeCanvasLightweight, markInteraction, profile]);
}

function getInteractionThumbnailEdge(profile: RuntimeProfile): number {
  return Math.max(48, Math.floor(profile.thumbnailEdge * 0.75));
}
