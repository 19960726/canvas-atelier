import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { expect, it, vi } from 'vitest';

// Exercise the actual main-process callback without booting Electron/services.
const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const start = main.indexOf('async function createGenerationHistoryPreview(');
const end = main.indexOf('\nasync function resolveProtocolFile(', start);
const callback = transformSync(main.slice(start, end), { loader: 'ts' }).code;
function setup(size = { width: 512, height: 1024 }) {
  const jpeg = Buffer.from('jpeg');
  const resized = { toJPEG: vi.fn(() => jpeg) };
  const image = { isEmpty: () => false, getSize: () => size, resize: vi.fn(() => resized), toJPEG: vi.fn(() => jpeg) };
  let complete!: (value: typeof image) => void;
  const nativeImage = {
    createThumbnailFromPath: vi.fn(() => new Promise<typeof image>(resolve => { complete = resolve; })),
    createFromPath: vi.fn(() => image),
  };
  const writeFile = vi.fn(async () => undefined);
  const run = new Function('nativeImage', 'writeFile', `${callback}; return createGenerationHistoryPreview;`)(nativeImage, writeFile) as (source: string, destination: string) => Promise<void>;
  return { run, nativeImage, image, resized, jpeg, writeFile, complete: () => complete(image) };
}

it('waits for the native thumbnail without decoding the full source on the main loop', async () => {
  const test = setup();
  const pending = test.run('managed/source.png', 'owned/preview.tmp');
  expect(test.nativeImage.createFromPath).not.toHaveBeenCalled();
  expect(test.nativeImage.createThumbnailFromPath).toHaveBeenCalledWith('managed/source.png', { width: 512, height: 512 });
  expect(test.writeFile).not.toHaveBeenCalled();
  test.complete();
  await pending;
  expect(test.image.resize).toHaveBeenCalledWith({ width: 256, height: 512, quality: 'good' });
  expect(test.resized.toJPEG).toHaveBeenCalledWith(78);
  expect(test.writeFile).toHaveBeenCalledWith('owned/preview.tmp', test.jpeg);
});

it('retains a small preview without upscaling', async () => {
  const test = setup({ width: 128, height: 64 });
  const pending = test.run('managed/small.png', 'owned/preview.tmp');
  expect(test.nativeImage.createThumbnailFromPath).toHaveBeenCalledOnce();
  test.complete();
  await pending;
  expect(test.image.resize).not.toHaveBeenCalled();
  expect(test.image.toJPEG).toHaveBeenCalledWith(78);
});

it('does not fall back to blocking full decoding or write a preview after native failure', async () => {
  const test = setup();
  test.nativeImage.createThumbnailFromPath.mockRejectedValueOnce(new Error('decode failed'));
  await expect(test.run('managed/bad.png', 'owned/preview.tmp')).rejects.toThrow('decode failed');
  expect(test.nativeImage.createFromPath).not.toHaveBeenCalled();
  expect(test.writeFile).not.toHaveBeenCalled();
});

it.each(['empty', 'invalid dimensions'])('rejects %s native previews without writing', async condition => {
  const test = setup(condition === 'invalid dimensions' ? { width: 0, height: 0 } : undefined);
  if (condition === 'empty') test.image.isEmpty = () => true;
  const pending = test.run('managed/bad.png', 'owned/preview.tmp');
  void pending.catch(() => undefined);
  expect(test.nativeImage.createThumbnailFromPath).toHaveBeenCalledOnce();
  const rejected = expect(pending).rejects.toThrow(/cannot be decoded|invalid dimensions/);
  test.complete();
  await rejected;
  expect(test.writeFile).not.toHaveBeenCalled();
});
