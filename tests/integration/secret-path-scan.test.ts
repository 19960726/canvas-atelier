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
});

function runScannerInIsolatedRoot(relativePath: string, content: string) {
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'novus-secret-scan-listed-'));
  isolatedRoots.push(isolatedRoot);
  const target = join(isolatedRoot, ...relativePath.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return spawnSync(process.execPath, [join(root, 'tests/e2e/helpers/secret-path-scan.mjs')], {
    cwd: isolatedRoot,
    encoding: 'utf8',
  });
}
