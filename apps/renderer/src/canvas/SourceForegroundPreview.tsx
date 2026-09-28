import { useEffect, useRef, useState } from 'react';
import { applyLayerSelection, boxSchema, readLayeringSelection } from '../app/layering-selection';
import { extractOriginalLayer } from '../app/source-layer-pixels';
import { decodeLayerPixels, layerPixelsUrl } from '../app/managed-layer-pixels';
import { enqueueLayerPreview } from './source-layer-preview';

export function SourceForegroundPreview({ sourceUrl, maskUrl, width, height, bounds, selection, label, maskSpace = 'bounds', onError }: {
  sourceUrl: string; maskUrl: string; width: number; height: number; bounds: unknown; selection: unknown; label: string;
  maskSpace?: 'source' | 'bounds';
  onError?: (error: string | null) => void;
}) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const key = JSON.stringify([sourceUrl, maskUrl, width, height, bounds, selection, maskSpace]);
  const [output, setOutput] = useState<{ key: string; url?: string; error?: string }>({ key: '' });
  useEffect(() => {
    let cancelled = false;
    onErrorRef.current?.(null);
    void enqueueLayerPreview(async () => {
      if (cancelled) return;
      const box = boxSchema.parse(bounds);
      const source = await decodeLayerPixels(sourceUrl, width, height);
      if (cancelled) return;
      const mask = await decodeLayerPixels(maskUrl, width, height);
      if (cancelled) return;
      const rgba = applyLayerSelection(extractOriginalLayer(source, mask, width, height, box, maskSpace), width, height, readLayeringSelection(selection));
      if (!rgba.some((value, index) => index % 4 === 3 && value > 0)) throw new Error('所选范围内没有可见像素，请校正原图位置');
      setOutput({ key, url: layerPixelsUrl(rgba, width, height) });
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
