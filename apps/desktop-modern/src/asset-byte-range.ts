/** undefined = full response; null = an unsatisfiable single byte range. */
export function parseAssetByteRange(header: string | null, size: number): { start: number; end: number } | null | undefined {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || size === 0 || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return null;
  if (first === undefined) return last! > 0 ? { start: Math.max(0, size - last!), end: size - 1 } : null;
  if (first >= size || (last !== undefined && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
