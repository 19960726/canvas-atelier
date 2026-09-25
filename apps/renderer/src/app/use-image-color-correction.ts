import { useEffect, useMemo, useState } from 'react';
import { AUTO_IMAGE_COLOR_CORRECTION, normalizeImageColorCorrection, resolveImageColorAnalysis, type ImageColorAnalysis, type ImageColorCorrection } from './image-color-correction';

/** Analysis is keyed by source, never by pan/zoom or slider render state. */
export function useImageColorCorrection(sourceUrl: string | undefined, value: ImageColorCorrection): ImageColorCorrection {
  return useImageColorCorrectionState(sourceUrl, value).correction;
}

export function useImageColorCorrectionState(sourceUrl: string | undefined, value: ImageColorCorrection) {
  const correction = useMemo(() => normalizeImageColorCorrection(value), [value]);
  const [analyzed, setAnalyzed] = useState<ImageColorAnalysis & { sourceUrl: string; request: ImageColorCorrection }>();
  useEffect(() => {
    if (correction.mode !== 'auto' || sourceUrl === undefined) return;
    let active = true;
    void resolveImageColorAnalysis(sourceUrl, correction).then((resolved) => {
      if (active) setAnalyzed({ ...resolved, sourceUrl, request: correction });
    });
    return () => { active = false; };
  }, [sourceUrl, correction]);
  if (correction.mode !== 'auto') return { correction, analysisStatus: undefined };
  if (analyzed?.sourceUrl === sourceUrl && analyzed?.request === correction) return { correction: analyzed.correction, analysisStatus: analyzed.status };
  return { correction: { ...AUTO_IMAGE_COLOR_CORRECTION, profile: correction.profile, strength: correction.strength }, analysisStatus: sourceUrl ? 'loading' as const : 'unavailable' as const };
}
