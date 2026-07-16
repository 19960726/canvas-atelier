import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const artifactFinding = join(root, 'playwright-report', 'secret-scan-red.txt');
const distFinding = join(root, 'packages', 'domain', 'dist', 'secret-scan-red.map');

afterEach(() => {
  rmSync(artifactFinding, { force: true });
  rmSync(distFinding, { force: true });
});

describe('secret/path scan coverage', () => {
  it('includes changed production roots and does not skip e2e artifact directories wholesale', () => {
    const script = readFileSync(join(root, 'tests/e2e/helpers/secret-path-scan.mjs'), 'utf8');

    expect(script).toContain("'apps/renderer/src'");
    expect(script).toContain("'packages/domain/src'");
    expect(script).toContain("'packages/desktop-core/src'");
    expect(script).toContain("'packages/skill-store/src'");
    expect(script).toContain("'apps/renderer/dist'");
    expect(script).toContain("'packages/domain/dist'");
    expect(script).toContain("'packages/desktop-core/dist'");
    expect(script).toContain("'package.json'");
    expect(script).toContain("'package-lock.json'");
    expect(script).toContain("'playwright-report'");
    expect(script).toContain("'test-results'");
    const excludedBlock = script.match(/const excludedSegments = new Set\(\[[\s\S]*?\]\);/)?.[0] ?? '';
    expect(excludedBlock).not.toContain("'dist'");
    expect(excludedBlock).not.toContain("'playwright-report'");
    expect(excludedBlock).not.toContain("'test-results'");
    expect(script).toContain("'.map'");
  });

  it('fails when a text Playwright report artifact contains an Authorization header', () => {
    mkdirSync(join(root, 'playwright-report'), { recursive: true });
    writeFileSync(artifactFinding, 'Authorization: Bearer scanner-should-detect-artifact-token\n', 'utf8');

    const result = spawnSync(process.execPath, ['tests/e2e/helpers/secret-path-scan.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('playwright-report');
  });

  it('fails when a generated dist source map contains an Authorization header', () => {
    mkdirSync(join(root, 'packages', 'domain', 'dist'), { recursive: true });
    writeFileSync(distFinding, '{"sourcesContent":["Authorization: Bearer scanner-should-detect-dist-token"]}\n', 'utf8');

    const result = spawnSync(process.execPath, ['tests/e2e/helpers/secret-path-scan.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('packages/domain/dist');
  });
});
