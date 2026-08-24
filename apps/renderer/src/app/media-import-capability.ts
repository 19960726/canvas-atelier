export type MediaImportMode = 'browser-picker' | 'desktop-managed';

export function resolveMediaImportMode(input: {
  readonly desktopBridge: unknown | undefined;
  readonly manualAcceptance: boolean;
}): MediaImportMode {
  return input.manualAcceptance || input.desktopBridge === undefined
    ? 'browser-picker'
    : 'desktop-managed';
}