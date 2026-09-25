import { describe, expect, it, vi } from 'vitest';
import { saveAndOpenLayeredPsdInPhotoshop } from './layered-psd-open';

function validPsd(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x38, 0x42, 0x50, 0x53, 0, 1], 0); // 8BPS, PSD v1
  bytes.set([0, 3, 0, 0, 0, 2, 0, 0, 0, 2, 0, 8, 0, 3], 12); // RGB, 2×2, 8-bit
  return bytes;
}

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
