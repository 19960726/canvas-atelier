import { normalize, resolve } from 'node:path';

export function resolveRendererHtmlPath(currentDir: string): string {
  return normalize(resolve(currentDir, '../../renderer/dist/index.html'));
}
