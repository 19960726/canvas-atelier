const minimumDisplayRatio = 9 / 16;
const maximumDisplayRatio = 16 / 9;

export function formatMediaDisplayAspectRatio(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (width === null || width === undefined || height === null || height === undefined) return '1 / 1';
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '1 / 1';
  const ratio = width / height;
  if (ratio < minimumDisplayRatio) return '9 / 16';
  if (ratio > maximumDisplayRatio) return '16 / 9';
  return `${width} / ${height}`;
}
