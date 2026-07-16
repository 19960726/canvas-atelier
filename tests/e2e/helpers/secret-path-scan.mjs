import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const included = [
  'playwright.config.ts',
  'tests/e2e',
  'apps/renderer/src/test-mode',
  'docs/testing/windows-compatibility-matrix.md',
];
const excludedSegments = new Set([
  '.git',
  '.superpowers',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);
const allowlistedPaths = new Set([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
]);

const checks = [
  { name: 'Authorization header', pattern: /authorization\s*:\s*(?:basic|bearer|token)?\s*\S+/i },
  { name: 'API key', pattern: /\b(?:sk-[a-z0-9_-]{8,}|AIza[0-9a-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[a-z0-9]{20,})\b/i },
  { name: 'JWT-like token', pattern: /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i },
  { name: 'raw base64 image payload', pattern: /data:image\/[^;]+;base64,/i },
  { name: 'private absolute path', pattern: /(?:[A-Za-z]:\\(?!Program Files \(x86\)\\Microsoft\\Edge\\Application\\msedge\.exe)[^\r\n"'`<>]+|\\\\[^\\\s]+\\[^\r\n"'`<>]+|file:\/\/[^\s"'`<>]+|(?:^|\s)\/(?:Users|home)\/[^\s"'`<>]+)/i },
];

const findings = [];
for (const entry of included) {
  scan(join(root, entry));
}

if (findings.length > 0) {
  console.error(findings.map((finding) => `${finding.file}: ${finding.name}`).join('\n'));
  process.exit(1);
}

console.log(`secret/path scan passed (${included.join(', ')})`);

function scan(path) {
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const child of readdirSync(path)) {
      if (excludedSegments.has(child)) continue;
      scan(join(path, child));
    }
    return;
  }
  if (!info.isFile()) return;
  if (path.endsWith('secret-path-scan.mjs')) return;
  if (!/\.(?:css|html|js|jsx|mjs|ts|tsx|md|json)$/.test(path)) return;

  const text = readFileSync(path, 'utf8');
  const cleaned = [...allowlistedPaths].reduce((value, allowed) => value.replaceAll(allowed, ''), text);
  for (const check of checks) {
    if (check.pattern.test(cleaned)) {
      findings.push({ file: relative(root, path), name: check.name });
    }
  }
}
