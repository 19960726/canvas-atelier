import { afterEach, expect, it, vi } from 'vitest';
import { readImageSourceBlob } from './image-source-blob';
afterEach(() => vi.unstubAllGlobals());
it('decodes local PNG bytes without making a CSP-controlled network request', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const blob = await readImageSourceBlob('data:image/png;base64,iVBORw0KGgo=');
  expect(blob.type).toBe('image/png');
  expect(blob.size).toBe(8);
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects malformed or non-image inline data and failed network responses', async () => {
  await expect(readImageSourceBlob('data:text/html;base64,WA==')).rejects.toThrow('Invalid inline image');
  await expect(readImageSourceBlob('data:image/png;base64,###')).rejects.toThrow('Invalid inline image');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  await expect(readImageSourceBlob('novus-asset://project/image')).rejects.toThrow('Image could not be loaded');
});
