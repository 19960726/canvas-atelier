import { useEffect, useMemo, useState } from 'react';
import { AUTO_IMAGE_COLOR_CORRECTION, normalizeImageColorCorrection, resolveImageColorCorrection, type ImageColorCorrection } from './image-color-correction';

/** Analysis is keyed by source, never by pan/zoom or slider render state. */
export function useImageColorCorrection(sourceUrl: string | undefined, value: ImageColorCorrection): ImageColorCorrection {
  const correction = useMemo(() => normalizeImageColorCorrection(value), [value]);
  const [analyzed, setAnalyzed] = useState<{ sourceUrl: string; correction: ImageColorCorrection }>();
  useEffect(() => {
    if (correction.mode !== 'auto' || sourceUrl === undefined) return;
    let active = true;
    void resolveImageColorCorrection(sourceUrl, AUTO_IMAGE_COLOR_CORRECTION).then((resolved) => {
      if (active) setAnalyzed({ sourceUrl, correction: resolved });
    });
    return () => { active = false; };
  }, [sourceUrl, correction.mode]);
  if (correction.mode !== 'auto') return correction;
  return analyzed !== undefined && analyzed.sourceUrl === sourceUrl ? analyzed.correction : AUTO_IMAGE_COLOR_CORRECTION;
}
