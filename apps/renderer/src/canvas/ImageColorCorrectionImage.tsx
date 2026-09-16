import { memo, useId, type ImgHTMLAttributes } from 'react';
import { imageColorCorrectionFilter, imageColorCorrectionMatrix, ORIGINAL_IMAGE_COLOR_CORRECTION, type ImageColorCorrection } from '../app/image-color-correction';
import { useImageColorCorrection } from '../app/use-image-color-correction';

export const ImageColorCorrectionImage = memo(function ImageColorCorrectionImage({
  correction,
  comparingOriginal = false,
  filterId,
  style,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & {
  correction: ImageColorCorrection;
  comparingOriginal?: boolean;
  filterId?: string;
}) {
  const uniqueId = useId();
  const resolved = useImageColorCorrection(props.src, correction);
  const id = filterId ?? `image-color-correction-${uniqueId.replace(/[^a-z0-9_-]/giu, '')}`;
  return <>
    <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', pointerEvents: 'none' }} className="module-node__color-correction-filter">
      <filter id={id} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={imageColorCorrectionMatrix(resolved)} /></filter>
    </svg>
    <img {...props} style={{ ...style, filter: imageColorCorrectionFilter(comparingOriginal ? ORIGINAL_IMAGE_COLOR_CORRECTION : resolved, id) }} />
  </>;
});
