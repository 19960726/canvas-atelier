import { extname } from 'node:path';

const MAX_PSD_BYTES = 256 * 1024 * 1024;
const MAX_PSD_SIDE = 8_192;

export type LayeredPsdOpenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'invalid_psd' | 'photoshop_not_installed' | 'discovery_failed' | 'cancelled' | 'dialog_failed' | 'save_failed' }
  | { readonly ok: false; readonly code: 'open_failed'; readonly saved: true };

export interface LayeredPsdOpenDependencies {
  findPhotoshop(): Promise<string | null>;
  chooseDestination(): Promise<string | null>;
  writePsd(path: string, bytes: Uint8Array): Promise<void>;
  launchPhotoshop(executablePath: string, psdPath: string): Promise<void>;
}

/** Save only user-chosen PSD bytes, then open that independent document in Photoshop. */
export async function saveAndOpenLayeredPsdInPhotoshop(
  bytes: unknown,
  dependencies: LayeredPsdOpenDependencies,
): Promise<LayeredPsdOpenResult> {
  if (!isPsdV1Rgb(bytes)) return { ok: false, code: 'invalid_psd' };
  let executablePath: string | null;
  try {
    executablePath = await dependencies.findPhotoshop();
  } catch {
    return { ok: false, code: 'discovery_failed' };
  }
  if (!executablePath) return { ok: false, code: 'photoshop_not_installed' };
  let selectedPath: string | null;
  try {
    selectedPath = await dependencies.chooseDestination();
  } catch {
    return { ok: false, code: 'dialog_failed' };
  }
  if (!selectedPath) return { ok: false, code: 'cancelled' };
  const psdPath = extname(selectedPath).toLowerCase() === '.psd' ? selectedPath : `${selectedPath}.psd`;
  try {
    await dependencies.writePsd(psdPath, bytes);
  } catch {
    return { ok: false, code: 'save_failed' };
  }
  try {
    await dependencies.launchPhotoshop(executablePath, psdPath);
    return { ok: true };
  } catch {
    return { ok: false, code: 'open_failed', saved: true };
  }
}

function isPsdV1Rgb(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 26 || value.byteLength > MAX_PSD_BYTES) return false;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  if (view.getUint32(0, false) !== 0x38425053 || view.getUint16(4, false) !== 1) return false;
  const channels = view.getUint16(12, false);
  const height = view.getUint32(14, false);
  const width = view.getUint32(18, false);
  const depth = view.getUint16(22, false);
  const colorMode = view.getUint16(24, false);
  return channels >= 3 && channels <= 4
    && height > 0 && height <= MAX_PSD_SIDE && width > 0 && width <= MAX_PSD_SIDE
    && depth === 8 && colorMode === 3;
}
