import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';

const root = process.cwd();
const included = [
  'apps/renderer/src',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'docs/testing',
  'tests',
  'playwright-report',
  'test-results',
];
const excludedSegments = new Set([
  '.git',
  '.superpowers',
  'dist',
  'node_modules',
]);
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.log',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yml',
  '.yaml',
]);
const binaryContentExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);
const allowlistedTexts = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
];
const allowedFindings = [
  {
    file: 'apps/renderer/src/app/app-store.test.ts',
    name: 'Authorization header',
    snippets: [
      'Authorization: ApiKey',
      'Authorization: Bearer secret-token-value',
      'Authorization: ApiKey abcdefghijklmnop',
      'Authorization: Bearer secret-token',
    ],
  },
  {
    file: 'apps/renderer/src/app/app-store.test.ts',
    name: 'raw base64 image payload',
    snippets: ['data:image/png;base64,'],
  },
  {
    file: 'apps/renderer/src/app/app-store.test.ts',
    name: 'private absolute path',
    snippets: [
      'Users/i);',
      'C:\\\\Users/i);',
      'C:\\\\Users\\\\private\\\\image.png',
      'C:\\\\Users\\\\private',
      'E:\\',
    ],
  },
  {
    file: 'apps/renderer/src/app/app-store.ts',
    name: 'private absolute path',
    snippets: [
      String.raw`\\[^\\\s]+\\/.test(value)`,
      String.raw`e:\/\//i.test(value)`,
    ],
  },
  {
    file: 'apps/renderer/src/app/knowledge-client.test.ts',
    name: 'Authorization header',
    snippets: ['Authorization: Bearer secret'],
  },
  {
    file: 'apps/renderer/src/app/knowledge-client.test.ts',
    name: 'private absolute path',
    snippets: ['C:\\Users\\Private\\sync.json'],
  },
  {
    file: 'apps/renderer/src/app/playwright-config.test.ts',
    name: 'private absolute path',
    snippets: [String.raw`p:\/\/127\.0\.0\.1:\d+$/);`],
  },
  {
    file: 'apps/renderer/src/jobs/job-store.test.ts',
    name: 'Authorization header',
    snippets: [
      'Authorization: Bearer secret-token',
      'Authorization: Bearer secret',
    ],
  },
  {
    file: 'apps/renderer/src/jobs/job-store.test.ts',
    name: 'raw base64 image payload',
    snippets: ['data:image/png;base64,'],
  },
  {
    file: 'apps/renderer/src/jobs/job-store.test.ts',
    name: 'private absolute path',
    snippets: [
      String.raw`private\\image.png`,
      'Users/i);',
      'Users|secret/i);',
      String.raw`private\\source.png`,
      'C:\\Users\\private\\image.png',
      'C:\\\\Users/i);',
      'C:\\\\Users|secret/i);',
      'C:\\Users\\private\\source.png',
    ],
  },
  {
    file: 'tests/integration/secret-path-scan.test.ts',
    name: 'Authorization header',
    snippets: ['Authorization: Bearer scanner-should-detect-artifact-token'],
  },
];

const checks = [
  {
    name: 'Authorization header',
    pattern: /authorization\s*:\s*(?:basic|bearer|token)?\s*\S+/gi,
  },
  {
    name: 'API key',
    pattern: /\b(?:sk-[a-z0-9_-]{8,}|AIza[0-9a-z_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[a-z0-9]{20,})\b/gi,
  },
  {
    name: 'JWT-like token',
    pattern: /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi,
  },
  {
    name: 'raw base64 image payload',
    pattern: /data:image\/[^;]+;base64,/gi,
  },
  {
    name: 'private absolute path',
    pattern: /(?:[A-Za-z]:\\(?!Program Files \(x86\)\\Microsoft\\Edge\\Application\\msedge\.exe)[^\r\n"'`<>]+|\\\\[^\\\s]+\\[^\r\n"'`<>]+|file:\/\/[^\s"'`<>]+|(?:^|\s)\/(?:Users|home)\/[^\s"'`<>]+)/gi,
  },
];

const findings = [];
for (const entry of included) {
  const path = join(root, entry);
  if (existsSync(path)) scan(path);
}

if (findings.length > 0) {
  console.error(findings.map((finding) => `${finding.file}: ${finding.name}: ${finding.evidence}`).join('\n'));
  process.exit(1);
}

console.log(`secret/path scan passed (${included.join(', ')})`);

function scan(path) {
  const info = statSync(path);
  const name = basename(path);
  if (info.isDirectory()) {
    if (excludedSegments.has(name)) return;
    for (const child of readdirSync(path)) {
      scan(join(path, child));
    }
    return;
  }
  if (!info.isFile()) return;

  const relativePath = normalizeRelativePath(path);
  scanText(relativePath, relativePath);

  const extension = extname(path).toLowerCase();
  if (extension === '.zip' && isArtifactPath(relativePath)) {
    scanZip(path, relativePath);
    return;
  }
  if (binaryContentExtensions.has(extension)) return;
  if (!textExtensions.has(extension)) return;
  if (relativePath === 'tests/e2e/helpers/secret-path-scan.mjs') return;

  scanText(relativePath, readFileSync(path, 'utf8'));
}

function scanZip(path, relativePath) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'novus-trace-scan-'));
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
      path,
      tempRoot,
    ], { stdio: 'ignore' });
    scanExtractedZip(tempRoot, relativePath, tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function scanExtractedZip(path, zipRelativePath, tempRoot) {
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const child of readdirSync(path)) {
      scanExtractedZip(join(path, child), zipRelativePath, tempRoot);
    }
    return;
  }
  if (!info.isFile()) return;

  const extractedRelativePath = `${zipRelativePath}!/${relative(tempRoot, path).replace(/\\/g, '/')}`;
  scanText(extractedRelativePath, extractedRelativePath);
  const extension = extname(path).toLowerCase();
  if (binaryContentExtensions.has(extension) || !textExtensions.has(extension)) return;
  scanText(extractedRelativePath, readFileSync(path, 'utf8'));
}

function scanText(relativePath, text) {
  const cleaned = allowlistedTexts.reduce((value, allowed) => value.replaceAll(allowed, ''), text);
  for (const check of checks) {
    for (const match of cleaned.matchAll(check.pattern)) {
      const evidence = match[0].trim();
      if (isAllowedFinding(relativePath, check.name, evidence)) continue;
      findings.push({ file: relativePath, name: check.name, evidence });
    }
  }
}

function isAllowedFinding(relativePath, name, evidence) {
  return allowedFindings.some((entry) => (
    entry.file === relativePath
    && entry.name === name
    && entry.snippets.some((snippet) => evidence.includes(snippet))
  ));
}

function isArtifactPath(relativePath) {
  return relativePath === 'playwright-report'
    || relativePath.startsWith('playwright-report/')
    || relativePath === 'test-results'
    || relativePath.startsWith('test-results/');
}

function normalizeRelativePath(path) {
  return relative(root, path).replace(/\\/g, '/');
}
