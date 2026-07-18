import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const artifactFinding = join(root, 'playwright-report', 'secret-scan-red.txt');
const distFinding = join(root, 'packages', 'domain', 'dist', 'secret-scan-red.map');
const distBase64Finding = join(root, 'apps', 'renderer', 'dist', 'secret-scan-base64-red.js');
const testPrivatePathFinding = join(root, 'tests', 'secret-scan-private-red.test.ts');
const testBase64Finding = join(root, 'tests', 'secret-scan-base64-red.test.ts');
const testTokenFinding = join(root, 'tests', 'secret-scan-token-red.test.ts');
const isolatedRoots: string[] = [];

afterEach(() => {
  rmSync(artifactFinding, { force: true });
  rmSync(distFinding, { force: true });
  rmSync(distBase64Finding, { force: true });
  rmSync(testPrivatePathFinding, { force: true });
  rmSync(testBase64Finding, { force: true });
  rmSync(testTokenFinding, { force: true });
  for (const isolatedRoot of isolatedRoots.splice(0)) {
    rmSync(isolatedRoot, { force: true, recursive: true });
  }
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

  it('fails when generated dist contains a real data image base64 payload', () => {
    mkdirSync(join(root, 'apps', 'renderer', 'dist'), { recursive: true });
    const payload = [`data:image/png;base${'64'}`, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'].join(',');
    writeFileSync(
      distBase64Finding,
      `const leaked = ${JSON.stringify(payload)};\n`,
      'utf8',
    );

    const result = spawnSync(process.execPath, ['tests/e2e/helpers/secret-path-scan.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('apps/renderer/dist');
    expect(`${result.stdout}\n${result.stderr}`).toContain('raw base64 image payload');
  });

  it('fails when an unlisted test file contains a private absolute path', () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(
      testPrivatePathFinding,
      `const leaked = ${JSON.stringify(['C:', 'Users', 'Alice', 'secret.png'].join(String.fromCharCode(92)))};\n`,
      'utf8',
    );

    const result = spawnSync(process.execPath, ['tests/e2e/helpers/secret-path-scan.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('tests/secret-scan-private-red.test.ts');
    expect(`${result.stdout}\n${result.stderr}`).toContain('private absolute path');
  });

  it('fails when an unlisted test file contains a raw base64 data image', () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    const payload = [`data:image/png;base${'64'}`, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'].join(',');
    writeFileSync(testBase64Finding, `const leaked = ${JSON.stringify(payload)};\n`, 'utf8');

    const result = spawnSync(process.execPath, ['tests/e2e/helpers/secret-path-scan.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('tests/secret-scan-base64-red.test.ts');
    expect(`${result.stdout}\n${result.stderr}`).toContain('raw base64 image payload');
  });

  it('fails when an unlisted test file contains an API key token', () => {
    mkdirSync(join(root, 'tests'), { recursive: true });
    const token = ['sk', 'scannerNegativeToken1234567890'].join('-');
    writeFileSync(testTokenFinding, `const leaked = ${JSON.stringify(token)};\n`, 'utf8');

    const result = spawnSync(process.execPath, ['tests/e2e/helpers/secret-path-scan.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('tests/secret-scan-token-red.test.ts');
    expect(`${result.stdout}\n${result.stderr}`).toContain('API key');
  });

  it('fails for an unlisted Authorization token in an allowlisted file and finding kind', () => {
    const result = runScannerInIsolatedRoot(
      'apps/renderer/src/app/knowledge-client.test.ts',
      'Authorization: Bearer secret-unlisted-variant-token\n',
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Authorization header');
  });

  it('fails for an unlisted private path in an allowlisted file and finding kind', () => {
    const privatePath = ['E:', 'unlisted', 'private-image.png'].join(String.fromCharCode(92));
    const result = runScannerInIsolatedRoot(
      'apps/renderer/src/app/app-store.test.ts',
      `const leaked = ${JSON.stringify(privatePath)};\n`,
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('private absolute path');
  });

  it('fails for an unlisted token in the scanner implementation file', () => {
    const token = ['sk', 'scannerImplementationUnexpectedToken1234567890'].join('-');
    const result = runScannerInIsolatedRoot(
      'tests/e2e/helpers/secret-path-scan.mjs',
      `const leaked = ${JSON.stringify(token)};\n`,
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('API key');
  });
  it('fails for an unlisted Base64 payload in an allowlisted file and finding kind', () => {
    const payload = [`data:image/png;base${'64'}`, 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='].join(',');
    const result = runScannerInIsolatedRoot(
      'apps/renderer/src/jobs/job-store.test.ts',
      `const leaked = ${JSON.stringify(payload)};\n`,
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('raw base64 image payload');
  });

  it.each([
    ['source', 'apps/renderer/src/race-private.ts'],
    ['test', 'tests/race-private.test.ts'],
    ['docs', 'docs/testing/race-private.md'],
  ])('retries a %s file that disappears and reappears instead of silently skipping it', (_kind, relativePath) => {
    const privatePath = ['C:', 'Users', 'Race', 'secret.txt'].join(String.fromCharCode(92));
    const result = runScannerInIsolatedRoot(
      relativePath,
      `const leaked = ${JSON.stringify(privatePath)};\n`,
      'restore',
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(relativePath);
    expect(`${result.stdout}\n${result.stderr}`).toContain('private absolute path');
  });

  it('tolerates a disposable generated dist file being removed during the scan', () => {
    const result = runScannerInIsolatedRoot(
      'apps/renderer/dist/race-generated.js',
      'const generated = true;\n',
      'remove',
    );

    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('secret/path scan passed');
  });
});

function runScannerInIsolatedRoot(
  relativePath: string,
  content: string,
  raceMode?: 'remove' | 'restore',
) {
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'novus-secret-scan-listed-'));
  isolatedRoots.push(isolatedRoot);
  const target = join(isolatedRoot, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  const scannerPath = join(root, 'tests/e2e/helpers/secret-path-scan.mjs');
  const args = raceMode === undefined
    ? [scannerPath]
    : ['--require', createStatRaceHook(isolatedRoot, target, raceMode), scannerPath];
  return spawnSync(process.execPath, args, {
    cwd: isolatedRoot,
    encoding: 'utf8',
  });
}

function createStatRaceHook(
  isolatedRoot: string,
  target: string,
  raceMode: 'remove' | 'restore',
): string {
  const hookPath = join(isolatedRoot, '.secret-scan-stat-race.cjs');
  writeFileSync(hookPath, `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const targetPath = ${JSON.stringify(target)};
const raceMode = ${JSON.stringify(raceMode)};
const originalStatSync = fs.statSync;
let injected = false;

fs.statSync = function statSyncWithRace(path, ...args) {
  if (!injected && String(path) === targetPath) {
    injected = true;
    const hiddenPath = targetPath + '.scan-race-hidden';
    fs.renameSync(targetPath, hiddenPath);
    if (raceMode === 'restore') fs.renameSync(hiddenPath, targetPath);
    const error = new Error('simulated concurrent file disappearance');
    error.code = 'ENOENT';
    throw error;
  }
  return originalStatSync.call(fs, path, ...args);
};

syncBuiltinESMExports();
`, 'utf8');
  return hookPath;
}
