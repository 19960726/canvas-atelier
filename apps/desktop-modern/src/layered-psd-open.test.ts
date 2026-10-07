import { describe, expect, it, vi } from 'vitest';
import { saveAndOpenLayeredPsdInPhotoshop } from './layered-psd-open';
import * as psdBoundary from './layered-psd-open';

function validPsd(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x38, 0x42, 0x50, 0x53, 0, 1], 0); // 8BPS, PSD v1
  bytes.set([0, 3, 0, 0, 0, 2, 0, 0, 0, 2, 0, 8, 0, 3], 12); // RGB, 2×2, 8-bit
  return bytes;
}

describe('trusted PSD save without Photoshop', () => {
  type SaveDependencies = { chooseDestination(): Promise<string | null>; writePsd(path: string, bytes: Uint8Array): Promise<void> };
  const save = (bytes: unknown, dependencies: SaveDependencies) =>
    (psdBoundary as unknown as { saveLayeredPsd(bytes: unknown, dependencies: SaveDependencies): Promise<unknown> }).saveLayeredPsd(bytes, dependencies);
  it('saves exact validated bytes to the native-dialog destination without needing Photoshop', async () => {
    const bytes = validPsd(); const writePsd = vi.fn(async () => undefined);
    await expect(save(bytes, { chooseDestination: async () => 'C:\\chosen\\layers', writePsd })).resolves.toEqual({ ok: true, saved: true });
    expect(writePsd).toHaveBeenCalledWith('C:\\chosen\\layers.psd', bytes);
  });
  it('rejects invalid or over-budget PSDs before opening the dialog', async () => {
    const chooseDestination = vi.fn(async () => 'C:\\chosen\\layers.psd'); const writePsd = vi.fn(async () => undefined);
    await expect(save(new Uint8Array([1,2,3]), { chooseDestination, writePsd })).resolves.toEqual({ ok: false, code: 'invalid_psd' });
    const oversizedCanvas = validPsd(); new DataView(oversizedCanvas.buffer).setUint32(18, 8193, false);
    await expect(save(oversizedCanvas, { chooseDestination, writePsd })).resolves.toEqual({ ok: false, code: 'invalid_psd' });
    expect(chooseDestination).not.toHaveBeenCalled(); expect(writePsd).not.toHaveBeenCalled();
  });
  it('reports cancel and save failures separately with no output path', async () => {
    const writePsd = vi.fn(async () => { throw new Error('private path'); });
    await expect(save(validPsd(), { chooseDestination: async () => null, writePsd })).resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(writePsd).not.toHaveBeenCalled();
    await expect(save(validPsd(), { chooseDestination: async () => 'C:\\chosen\\layers.psd', writePsd })).resolves.toEqual({ ok: false, code: 'save_failed' });
  });
  it('rejects foreign or missing window senders through the actual IPC handler before the dialog', async () => {
    const trustedSender = {}, foreignSender = {}, chooseDestination = vi.fn(async () => 'C:\\chosen\\layers.psd'), writePsd = vi.fn(async () => undefined);
    const createHandler = (psdBoundary as unknown as { createLayeredPsdSaveHandler(getSender: () => unknown, deps: SaveDependencies): (event: { sender: unknown }, bytes: unknown) => Promise<unknown> }).createLayeredPsdSaveHandler;
    const handler = createHandler(() => trustedSender, { chooseDestination, writePsd });
    await expect(handler({ sender: foreignSender }, validPsd())).resolves.toEqual({ ok: false, code: 'invalid_psd' });
    await expect(createHandler(() => undefined, { chooseDestination, writePsd })({ sender: undefined }, validPsd())).resolves.toEqual({ ok: false, code: 'invalid_psd' });
    expect(chooseDestination).not.toHaveBeenCalled(); expect(writePsd).not.toHaveBeenCalled();
    await expect(handler({ sender: trustedSender }, validPsd())).resolves.toEqual({ ok: true, saved: true });
  });
});

describe('layered PSD desktop open boundary', () => {
  it('rejects invalid bytes before asking for a file or launching Photoshop', async () => {
    const chooseDestination = vi.fn(async () => 'C:\\output\\layers.psd');
    const launchPhotoshop = vi.fn(async () => undefined);
    const result = await saveAndOpenLayeredPsdInPhotoshop(new Uint8Array([1, 2, 3]), {
      findPhotoshop: async () => 'C:\\Adobe\\Photoshop.exe', chooseDestination,
      writePsd: async () => undefined, launchPhotoshop,
    });
    expect(result).toEqual({ ok: false, code: 'invalid_psd' });
    expect(chooseDestination).not.toHaveBeenCalled();
    expect(launchPhotoshop).not.toHaveBeenCalled();
  });

  it('saves the exact PSD and launches Photoshop with only its chosen path', async () => {
    const bytes = validPsd();
    const writePsd = vi.fn(async () => undefined);
    const launchPhotoshop = vi.fn(async () => undefined);
    const result = await saveAndOpenLayeredPsdInPhotoshop(bytes, {
      findPhotoshop: async () => 'C:\\Adobe\\Photoshop.exe',
      chooseDestination: async () => 'C:\\output\\layers', writePsd, launchPhotoshop,
    });
    expect(result).toEqual({ ok: true });
    expect(writePsd).toHaveBeenCalledWith('C:\\output\\layers.psd', bytes);
    expect(launchPhotoshop).toHaveBeenCalledWith('C:\\Adobe\\Photoshop.exe', 'C:\\output\\layers.psd');
  });

  it('does not write on cancel and reports a saved file if Photoshop cannot start', async () => {
    const writePsd = vi.fn(async () => undefined);
    const dependencies = {
      findPhotoshop: async () => 'C:\\Adobe\\Photoshop.exe',
      chooseDestination: async () => null as string | null,
      writePsd,
      launchPhotoshop: vi.fn(async () => { throw new Error('private path'); }),
    };
    await expect(saveAndOpenLayeredPsdInPhotoshop(validPsd(), dependencies))
      .resolves.toEqual({ ok: false, code: 'cancelled' });
    expect(writePsd).not.toHaveBeenCalled();
    await expect(saveAndOpenLayeredPsdInPhotoshop(validPsd(), {
      ...dependencies, chooseDestination: async () => 'C:\\output\\layers.psd',
    })).resolves.toEqual({ ok: false, code: 'open_failed', saved: true });
  });

  it('returns explicit failures when Photoshop discovery or the save dialog rejects', async () => {
    const writePsd = vi.fn(async () => undefined);
    const launchPhotoshop = vi.fn(async () => undefined);
    await expect(saveAndOpenLayeredPsdInPhotoshop(validPsd(), {
      findPhotoshop: async () => { throw new Error('private discovery path'); },
      chooseDestination: async () => 'C:\\output\\layers.psd', writePsd, launchPhotoshop,
    })).resolves.toEqual({ ok: false, code: 'discovery_failed' });
    await expect(saveAndOpenLayeredPsdInPhotoshop(validPsd(), {
      findPhotoshop: async () => 'C:\\Adobe\\Photoshop.exe',
      chooseDestination: async () => { throw new Error('private dialog state'); },
      writePsd, launchPhotoshop,
    })).resolves.toEqual({ ok: false, code: 'dialog_failed' });
    expect(writePsd).not.toHaveBeenCalled();
    expect(launchPhotoshop).not.toHaveBeenCalled();
  });
});
