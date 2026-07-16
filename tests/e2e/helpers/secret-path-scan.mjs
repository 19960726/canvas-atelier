import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';

const root = process.cwd();
const included = [
  'apps/renderer/src',
  'packages/domain/src',
  'packages/desktop-core/src',
  'packages/skill-store/src',
  'apps/desktop-legacy/dist',
  'apps/desktop-modern/dist',
  'apps/renderer/dist',
  'packages/desktop-bridge/dist',
  'packages/desktop-core/dist',
  'packages/domain/dist',
  'packages/provider-comfly/dist',
  'packages/skill-store/dist',
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
  'node_modules',
]);
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsonl',
  '.log',
  '.map',
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
const redactionImplementationFiles = new Set([
  'apps/renderer/src/app/app-store.ts',
  'packages/domain/src/model-job.ts',
  'packages/domain/src/project-memory.ts',
  'packages/desktop-core/src/approved-snapshot-outbox.ts',
  'packages/desktop-core/src/approved-snapshot-pull.ts',
  'packages/desktop-core/src/bridge-handlers.ts',
  'packages/desktop-core/src/confined-file-lock.ts',
  'packages/desktop-core/src/electron-net-fetch.ts',
  'packages/desktop-core/src/knowledge-refresh-service.ts',
  'packages/desktop-core/src/managed-knowledge-store.ts',
  'packages/desktop-core/src/novus-pack.ts',
  'packages/desktop-core/src/preload-api.ts',
  'packages/desktop-core/src/provider-bridge.ts',
  'packages/desktop-core/src/provider-contracts.ts',
  'packages/desktop-core/src/test/crash-child.ts',
  'packages/skill-store/src/knowledge-registry.ts',
  'packages/skill-store/src/knowledge-snapshot.ts',
  'packages/skill-store/src/memory-sync-client.ts',
  'packages/skill-store/src/offline-outbox.ts',
]);
const allowedFindings = [
  {
    file: "tests/e2e/helpers/secret-path-scan.mjs",
    name: "scanner implementation hash",
    hash: "0cb763c7bee8588f77059e68bbfc4c83e0a7e1b8ccf0e71e989ce271abd69ec9",
  },
  {
    file: "apps/renderer/src/app/app-store.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: ApiKey",
      "Authorization: Bearer secret-token",
      "Authorization: Bearer secret-token-value',",
    ],
  },
  {
    file: "apps/renderer/src/app/app-store.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Users\\\\private\\\\image.png",
      "C:\\\\\\\\Users/i);",
      "E:\\\\",
    ],
  },
  {
    file: "apps/renderer/src/app/app-store.test.ts",
    name: "raw base64 image payload",
    evidence: [
      "data:image/png;base64,AAAAAAAAAAAAAAAA",
    ],
  },
  {
    file: "apps/renderer/src/app/knowledge-client.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer secret",
    ],
  },
  {
    file: "apps/renderer/src/app/knowledge-client.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\Users\\Private\\sync.json",
    ],
  },
  {
    file: "apps/renderer/src/app/playwright-config.test.ts",
    name: "private absolute path",
    evidence: [
      "p:\\/\\/127\\.0\\.0\\.1:\\d+$/);",
    ],
  },
  {
    file: "apps/renderer/src/jobs/job-store.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer secret",
      "Authorization: Bearer secret-token",
    ],
  },
  {
    file: "apps/renderer/src/jobs/job-store.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Users\\\\private\\\\image.png",
      "C:\\\\Users\\\\private\\\\source.png",
      "C:\\\\\\\\Users/i);",
      "C:\\\\\\\\Users|secret/i);",
    ],
  },
  {
    file: "apps/renderer/src/jobs/job-store.test.ts",
    name: "raw base64 image payload",
    evidence: [
      "data:image/png;base64,AAAAAAAAAAAAAAAAAAAA",
    ],
  },
  {
    file: "packages/desktop-core/src/approved-snapshot-outbox.test.ts",
    name: "Authorization header",
    evidence: [
      "authorization: 'Bearer",
    ],
  },
  {
    file: "packages/desktop-core/src/bridge-contract.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer secret",
    ],
  },
  {
    file: "packages/desktop-core/src/bridge-contract.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Program Files\\\\Novus Atelier\\\\foo.txt",
      "C:\\\\Users\\\\Private\\\\Documents",
      "C:\\\\Users\\\\Private\\\\Knowledge",
      "C:\\\\Users\\\\Private\\\\draft.json",
      "C:\\\\Users\\\\Private\\\\sync.json",
      "C:\\\\redacted\\\\AppData",
      "C:\\\\redacted\\\\Demo.novus-project",
      "C:\\\\redacted\\\\One.novus-project",
      "C:\\\\redacted\\\\Two.novus-project",
      "C:\\redacted\\knowledge",
      "E:\\\\画布项目\\\\demo\\\\project.novus.json",
      "\\\\server\\\\share\\\\Folder With Spaces\\\\image.png",
      "file:///E:/canvas",
      "file:///E:/画布项目/demo/project.novus.json",
    ],
  },
  {
    file: "packages/desktop-core/src/confined-file-lock.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\app-data/u);",
      "C:\\\\app-data\\\\sync\\\\state.lock",
    ],
  },
  {
    file: "packages/desktop-core/src/crash-recovery.integration.test.ts",
    name: "private absolute path",
    evidence: [
      "file:///E:/private/workspace/crash-child.ts:10:2",
    ],
  },
  {
    file: "packages/desktop-core/src/knowledge-refresh-service.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer protected-value');",
      "Authorization: Bearer secret-token-value',",
    ],
  },
  {
    file: "packages/desktop-core/src/knowledge-refresh-service.test.ts",
    name: "raw base64 image payload",
    evidence: [
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA",
    ],
  },
  {
    file: "packages/desktop-core/src/knowledge-startup.test.ts",
    name: "private absolute path",
    evidence: [
      "\\\\|\\\\\\\\/u);",
    ],
  },
  {
    file: "packages/desktop-core/src/managed-knowledge-store.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer secret',",
    ],
  },
  {
    file: "packages/desktop-core/src/managed-knowledge-store.test.ts",
    name: "JWT-like token",
    evidence: [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature",
    ],
  },
  {
    file: "packages/desktop-core/src/managed-knowledge-store.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Users\\\\Private\\\\skill",
      "D:\\\\buildkite\\\\secret",
    ],
  },
  {
    file: "packages/desktop-core/src/novus-pack.test.ts",
    name: "API key",
    evidence: [
      "sk-live-secret",
    ],
  },
  {
    file: "packages/desktop-core/src/novus-pack.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer sk-live-secret',",
    ],
  },
  {
    file: "packages/desktop-core/src/novus-pack.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Program Files\\\\Novus Atelier\\\\image.png",
      "C:\\\\Users\\\\Administrator\\\\secret\\\\image.png",
      "E:\\\\画布项目\\\\demo\\\\project.novus.json",
      "\\\\server\\\\share\\\\Folder With Spaces\\\\image.png",
      "file:///E:/canvas",
      "file:///E:/画布项目/demo/project.novus.json",
    ],
  },
  {
    file: "packages/desktop-core/src/provider-bridge.test.ts",
    name: "API key",
    evidence: [
      "sk-config-write-failure-token",
      "sk-credential-write-failure-token",
      "sk-first-rotation-token",
      "sk-first-token-value",
      "sk-legacy-mapping-token",
      "sk-legacy-migration-token",
      "sk-new-config-token",
      "sk-new-credential-token",
      "sk-old-config-token",
      "sk-old-credential-token",
      "sk-original-credential-token",
      "sk-original-post-verify-token",
      "sk-passphrase-config-token",
      "sk-rollback-delete-target",
      "sk-rotated-after-legacy-migration",
      "sk-rotated-credential-token",
      "sk-rotated-post-verify-token",
      "sk-safe-config-token",
      "sk-second-rotation-token",
      "sk-second-token-value",
      "sk-task-9-secret-token",
    ],
  },
  {
    file: "packages/desktop-core/src/provider-bridge.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer ${token}",
      "Authorization: Bearer ${token}`,",
      "authorization: 'Bearer",
      "authorization: [`Bearer",
      "authorization: `Bearer",
    ],
  },
  {
    file: "packages/desktop-core/src/provider-bridge.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Users\\\\Private\\\\generated.png",
      "C:\\\\Users\\\\Private\\\\image.png",
      "C:\\\\Users\\\\Private\\\\source.png",
      "C:\\\\Users|mappingKey/i);",
      "C:\\\\\\\\Users/i);",
      "s:\\/\\/assets\\.example|generated\\.png/i);",
    ],
  },
  {
    file: "packages/desktop-core/src/provider-bridge.test.ts",
    name: "raw base64 image payload",
    evidence: [
      "data:image/png;base64,AAAAAAAAAAAAAAAAAAAA",
    ],
  },
  {
    file: "packages/desktop-core/src/renderer-close-flush.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: 'Bearer",
    ],
  },
  {
    file: "packages/desktop-core/src/renderer-close-flush.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Users\\\\Private\\\\draft.json",
    ],
  },
  {
    file: "packages/domain/src/model-job.test.ts",
    name: "API key",
    evidence: [
      "sk-secret-token-value",
    ],
  },
  {
    file: "packages/domain/src/model-job.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer sk-secret-token-value",
    ],
  },
  {
    file: "packages/domain/src/model-job.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\Users\\\\private\\\\source.png data:image/png;base64,AAAAAAAAAAAAAAAAAAAA",
      "C:\\\\Users|data:image|base64/i);",
    ],
  },
  {
    file: "packages/domain/src/model-job.test.ts",
    name: "raw base64 image payload",
    evidence: [
      "data:image/png;base64,AAAAAAAAAAAAAAAAAAAA",
    ],
  },
  {
    file: "packages/domain/src/project-memory.test.ts",
    name: "API key",
    evidence: [
      "ghp_1234567890abcdefghijklmnop",
      "sk-project-secret1234",
    ],
  },
  {
    file: "packages/domain/src/project-memory.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Basic Zm9vOmJhcg=='",
      "Authorization: Bearer secret-token-value'",
    ],
  },
  {
    file: "packages/domain/src/project-memory.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\private\\\\asset.png",
      "D:\\\\private\\\\asset.png",
      "\\\\private\\\\key.txt",
    ],
  },
  {
    file: "packages/skill-store/src/candidate-builder.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\private\\\\notes.md",
    ],
  },
  {
    file: "packages/skill-store/src/generation-memory.test.ts",
    name: "Authorization header",
    evidence: [
      "authorization: 'Bearer",
    ],
  },
  {
    file: "packages/skill-store/src/import-skill.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\managed",
    ],
  },
  {
    file: "packages/skill-store/src/memory-sync-client.test.ts",
    name: "Authorization header",
    evidence: [
      "authorization: 'Bearer",
    ],
  },
  {
    file: "packages/skill-store/src/offline-outbox.test.ts",
    name: "Authorization header",
    evidence: [
      "authorization: true,",
    ],
  },
  {
    file: "packages/skill-store/src/offline-outbox.test.ts",
    name: "private absolute path",
    evidence: [
      "C:\\\\managed",
      "C:\\\\managed\\\\app",
      "C:\\\\managed\\\\base",
      "C:\\\\managed\\\\source",
      "C:\\\\private\\\\agent",
      "C:\\\\private\\\\agent\\\\memory\\\\main-memory.md QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
      "C:\\\\private\\\\agent\\\\memory\\\\writeback-history.log",
    ],
  },
  {
    file: "tests/integration/secret-path-scan.test.ts",
    name: "Authorization header",
    evidence: [
      "Authorization: Bearer scanner-should-detect-artifact-token\\n',",
      "Authorization: Bearer scanner-should-detect-dist-token\"]}\\n',",
      "Authorization: Bearer secret-unlisted-variant-token\\n',",
    ],
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
    pattern: /data:image\/[^;]+;base64,[a-z0-9+/=]{16,}/gi,
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
  if (relativePath === 'tests/e2e/helpers/secret-path-scan.mjs') {
    scanScannerImplementation(relativePath, readFileSync(path, 'utf8'));
    return;
  }
  if (extension === '.map' && scanSourceMap(path, relativePath)) return;

  const content = readFileSync(path, 'utf8');
  scanDistDataImagePayload(relativePath, content);
  scanText(relativePath, content);
}

function scanScannerImplementation(relativePath, text) {
  const implementation = scannerImplementationSource(text);
  if (implementation === null) {
    scanText(relativePath, text);
    return;
  }
  const expectedHash = allowedFindings.find((entry) => entry.file === relativePath && entry.name === 'scanner implementation hash')?.hash;
  const actualHash = createHash('sha256').update(implementation).digest('hex');
  if (expectedHash !== actualHash) {
    findings.push({ file: relativePath, name: 'scanner implementation hash', evidence: actualHash });
  }
}

function scannerImplementationSource(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const implementation = normalized.replace(
    /const allowedFindings = \[[\s\S]*?\n\];\n\nconst checks =/u,
    'const allowedFindings = [];\n\nconst checks =',
  );
  return implementation === normalized ? null : implementation;
}
function scanSourceMap(path, relativePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  if (!Array.isArray(parsed.sources) || !Array.isArray(parsed.sourcesContent)) {
    return false;
  }

  const manifest = { ...parsed, sourcesContent: [] };
  scanText(relativePath, JSON.stringify(manifest));
  parsed.sources.forEach((source, index) => {
    const sourcePath = normalizeSourceMapSource(typeof source === 'string' ? source : `source-${index}`);
    scanText(`${relativePath}!/${sourcePath}`, sourcePath);
    const content = parsed.sourcesContent[index];
    if (typeof content !== 'string' || isThirdPartySourceMapSource(sourcePath)) return;
    scanText(`${relativePath}!/${sourcePath}`, content);
  });
  return true;
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

function scanDistDataImagePayload(relativePath, text) {
  if (!isDistPath(relativePath)) return;
  const cleaned = allowlistedTexts.reduce((value, allowed) => value.replaceAll(allowed, ''), text);
  for (const match of cleaned.matchAll(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]{16,}/gi)) {
    const evidence = match[0].trim();
    if (!isGeneratedBundleLiteral('raw base64 image payload', evidence)) {
      findings.push({ file: relativePath, name: 'raw base64 image payload', evidence });
    }
  }
}

function isAllowedFinding(relativePath, name, evidence) {
  return allowedFindings.some((entry) => (
    entry.file === relativePath
    && entry.name === name
    && entry.evidence?.some((allowedEvidence) => allowedEvidence === evidence) === true
  ))
    || isRedactionImplementationFinding(relativePath, name, evidence);
}

function isRedactionImplementationFinding(relativePath, name, evidence) {
  const sourcePath = sourceIdentityPath(relativePath);
  if (sourcePath.includes('/dist/')) return isGeneratedBundleLiteral(name, evidence);
  if (!isRedactionImplementationPath(sourcePath)) return false;
  if (/\[REDACTED(?:_[A-Z]+)?\]|\[redacted(?:-[a-z]+)?\]/u.test(evidence)) return true;
  if (/authorization/i.test(evidence)) {
    return /(?:\\s|\\S|\/gi|\/iu|\/i|`Bearer|'Bearer|\$\{token\}|authorization: true|authorization: false|authorization: boolean|authorization: WritebackAuthorization)/u.test(evidence);
  }
  if (name === 'API key') {
    return /(?:\\bsk-|redacted-key|sk-\[|sk-\()/u.test(evidence);
  }
  if (name === 'JWT-like token') {
    return /eyJ\[|eyJ[a-z0-9_-]\+/iu.test(evidence);
  }
  if (name === 'raw base64 image payload') {
    return /(?:data:image\\\/\[\^|data:image\\\/[a-z0-9.+-]\+;base64,\[|data:\[\^|base64,\[[^\]]+\]\{)/u.test(evidence);
  }
  if (name === 'private absolute path') {
    return /(?:\\s|\\S|\\r|\\n|\[\^|\\\/|\/u|\/i|file:\\\/|e:\\\/|[A-Za-z]:\\\[|\\\\\\|\(\?:)/u.test(evidence);
  }
  return false;
}

function isGeneratedBundleLiteral(name, evidence) {
  if (/\[REDACTED(?:_[A-Z]+)?\]|\[redacted(?:-[a-z]+)?\]/u.test(evidence)) return true;
  if (/authorization/i.test(evidence)) {
    return /(?:\\s|\\S|\\b|\/gi|\/iu|\/i|`Bearer|'Bearer|\$\{token\}|authorization:\s*(?:true|false|boolean|WritebackAuthorization))/u.test(evidence);
  }
  if (name === 'API key') {
    return /(?:\\bsk-|redacted-key|sk-\[|sk-\()/u.test(evidence);
  }
  if (name === 'JWT-like token') {
    return /eyJ\[|eyJ[a-z0-9_-]\+/iu.test(evidence);
  }
  if (name === 'raw base64 image payload') {
    return /(?:data:image\\\/\[\^|data:image\\\/[a-z0-9.+-]\+;base64,\[|data:\[\^|base64,\[[^\]]+\]\{)/u.test(evidence);
  }
  if (name === 'private absolute path') {
    return /(?:\\s|\\S|\\d|\\p|\\u|\\x|\[\^|\(\?:|\\\/|\/[gimuys]*[,;)]|file:\\\/|e:\\\/|escSlash|escClose|\$&|\\\.|\\[{}()])/u.test(evidence)
      || /^[a-z]:\\n$/u.test(evidence);
  }
  return false;
}

function isDistPath(relativePath) {
  return relativePath.includes('/dist/');
}

function isRedactionImplementationPath(sourcePath) {
  if (redactionImplementationFiles.has(sourcePath)) return true;
  if (!sourcePath.includes('/dist/')) return false;
  const sourceCandidate = sourcePath
    .replace('/dist/', '/src/')
    .replace(/\.js$/u, '.ts');
  return redactionImplementationFiles.has(sourceCandidate);
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

function normalizeSourceMapSource(source) {
  return source
    .replace(/\\/g, '/')
    .replace(/^webpack:\/\//u, '')
    .replace(/^\/@fs\//u, '')
    .replace(/^(\.\/)+/u, '')
    .replace(/^(\.\.\/)+/u, '');
}

function sourceIdentityPath(relativePath) {
  const sourcePath = relativePath.includes('!/')
    ? relativePath.slice(relativePath.lastIndexOf('!/') + 2)
    : relativePath;
  const normalized = normalizeSourceMapSource(sourcePath);
  if (relativePath.startsWith('apps/renderer/dist/') && normalized.startsWith('src/')) {
    return `apps/renderer/${normalized}`;
  }
  return normalized;
}

function isThirdPartySourceMapSource(sourcePath) {
  return sourcePath === 'node_modules'
    || sourcePath.includes('/node_modules/')
    || sourcePath.startsWith('node_modules/');
}
