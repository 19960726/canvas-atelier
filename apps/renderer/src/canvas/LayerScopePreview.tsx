import { useId } from 'react';
import type { LayeringSelection } from '../app/layering-selection';

/** SVG keeps the scope in image coordinates even when a portrait is letterboxed in a wide node. */
export function LayerScopePreview({ url, sourceUrl, selection, background, width, height, label }: {
  url: string; sourceUrl?: string; selection: LayeringSelection; background: boolean;
  width: number; height: number; label: string;
}) {
  const id = useId().replace(/:/g, '');
  if (selection.mode === 'whole') return <img src={url} alt={label} loading="lazy" decoding="async" />;
  const { x, y, width: w, height: h } = selection.box;
  return <svg className="image-layering__scope-preview" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    <defs><clipPath id={id}><rect x={x * width} y={y * height} width={w * width} height={h * height} /></clipPath></defs>
    {background && sourceUrl && <image href={sourceUrl} width={width} height={height} preserveAspectRatio="none" />}
    <image href={url} width={width} height={height} preserveAspectRatio="none" clipPath={`url(#${id})`} />
  </svg>;
}
