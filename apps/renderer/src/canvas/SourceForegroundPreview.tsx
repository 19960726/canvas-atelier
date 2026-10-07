import { useEffect, useRef, useState } from 'react';
import { boxSchema, readLayeringSelection } from '../app/layering-selection';
import { computeSourceForegroundOffThread } from '../app/source-layer-compute';
import { decodeLayerPixels, layerPixelsUrl } from '../app/managed-layer-pixels';
import { enqueueLayerPreview } from './source-layer-preview';

export function SourceForegroundPreview({ sourceUrl, maskUrl, width, height, bounds, selection, label, maskSpace = 'bounds', independentRgba = false, onError }: {
  sourceUrl: string; maskUrl: string; width: number; height: number; bounds: unknown; selection: unknown; label: string;
  maskSpace?: 'source' | 'bounds';
  /** The mask URL contains straight RGBA candidate pixels for v2 results. */
  independentRgba?: boolean;
  onError?: (error: string | null) => void;
}) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const key = JSON.stringify([sourceUrl, maskUrl, width, height, bounds, selection, maskSpace, independentRgba]);
  const [output, setOutput] = useState<{ key: string; url?: string; error?: string }>({ key: '' });
  useEffect(() => {
    let cancelled = false;
    onErrorRef.current?.(null);
    void enqueueLayerPreview(async () => {
      if (cancelled) return;
      const box = boxSchema.parse(bounds);
      let rgba: Uint8Array;
      if (independentRgba) {
        // A v2 candidate already carries straight RGBA. Decoding the source
        // and extracting a matte here would replace its RGB with source RGB.
        const mask = await decodeLayerPixels(maskUrl, width, height);
        if (cancelled) return;
        rgba = await computeSourceForegroundOffThread({ mask, width, height, bounds: box, selection: readLayeringSelection(selection) });
      } else {
        const source = await decodeLayerPixels(sourceUrl, width, height);
        if (cancelled) return;
        const mask = await decodeLayerPixels(maskUrl, width, height);
        if (cancelled) return;
        rgba = await computeSourceForegroundOffThread({ source, mask, width, height, bounds: box, maskSpace, selection: readLayeringSelection(selection) });
      }
      if (cancelled) return;
      const url = await layerPixelsUrl(rgba, width, height);
      if (!cancelled) setOutput({ key, url });
    }).catch(error => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : '原图像素读取失败';
      setOutput({ key, error: message });
      onErrorRef.current?.(message);
    });
    return () => { cancelled = true; };
  }, [key]);
  if (output.key !== key) return <span role="status">正在提取原图像素…</span>;
  return output.url ? <img src={output.url} alt={label} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : <span role="alert">{output.error}</span>;
}
