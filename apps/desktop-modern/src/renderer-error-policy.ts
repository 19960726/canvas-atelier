const benignRendererMessages = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
]);

export function isBenignRendererError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return benignRendererMessages.has(message.trim());
}
