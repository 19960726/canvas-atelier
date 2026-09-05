import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve('apps/renderer/src');

function productionFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    if (!/\.(?:ts|tsx|css)$/u.test(entry.name) || /\.test\.(?:ts|tsx)$/u.test(entry.name)) return [];
    return [path];
  });
}

const retiredBrandToken = ['fig', 'ma'].join('');

describe('generic canvas runtime contract', () => {
  it('does not ship retired design-tool runtime identifiers', () => {
    const violations = productionFiles(rendererRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return new RegExp(`(?<![A-Za-z])${retiredBrandToken}(?![A-Za-z])`, 'iu').test(source)
        ? [path.replace(`${rendererRoot}\\`, '')]
        : [];
    });
    expect(violations).toEqual([]);
  });

  it('loads the generic canvas layout stylesheet after base styles', () => {
    const source = readFileSync(resolve('apps/renderer/src/main.tsx'), 'utf8');
    expect(source).toContain("import './styles/canvas-layout.css';");
    expect(source).not.toContain(`${retiredBrandToken}-hybrid-canvas.css`);
  });
});
