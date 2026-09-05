import { readdirSync, readFileSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

type LegacyIdentityHit = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

type CompatibilityRule = {
  readonly reason: string;
  readonly file: RegExp;
  readonly text: RegExp;
};

const SOURCE_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.jsx', '.mjs', '.nsh', '.ts', '.tsx', '.yaml', '.yml']);
const SKIPPED_DIRECTORIES = new Set(['dist', 'dist-builder', 'node_modules']);
const COMPATIBILITY_ALLOWLIST: readonly CompatibilityRule[] = Object.freeze([
  { reason: 'stable wire protocol', file: /^(apps|packages)\//u, text: /canvasforge\.mcp\.(?:pipe|runtime|workflow|snapshot|plan)\.v1/iu },
  { reason: 'stable local pipe namespace', file: /^(apps|packages)\//u, text: /canvasforge-mcp-/iu },
  { reason: 'packaged compatibility resource filename', file: /^(apps|packages)\//u, text: /canvasforge-mcp\.cjs/iu },
  { reason: 'legacy environment variable', file: /^(apps|packages)\//u, text: /CANVASFORGE_(?:MCP_RUNTIME_FILE|CODEX_CONFIG_PATH|WORKBUDDY_CONFIG_PATH|CODEX_EXECUTABLE_PATH|QA_MODE|QA_HIDDEN|QA_USER_DATA_ROOT|FORMAL_QA_OFFLINE)/u },
  { reason: 'legacy user-data migration source', file: /^packages\/desktop-core\/src\/user-data-migration\.ts$/u, text: /CanvasForge/u },
  { reason: 'legacy shortcut removal during install', file: /^apps\/desktop-modern\/build\/installer\.nsh$/u, text: /(?:Delete|RMDir).*CanvasForge/u },
  { reason: 'isolated formal-QA compatibility namespace', file: /^apps\/desktop-modern\/src\/(?:formal-qa-network-guard|qa-user-data-root)\.ts$/u, text: /(?:canvasforge-(?:formal-qa|qa)|__CANVASFORGE_FORMAL_QA_NETWORK_GUARD__)/iu },
]);

describe('MCP production product identity', () => {
  it('allows the legacy name only in explicit internal compatibility boundaries', () => {
    const workspaceRoot = resolve(process.cwd());
    const hits = ['apps', 'packages'].flatMap((directory) => collectLegacyIdentityHits(workspaceRoot, resolve(workspaceRoot, directory)));
    const unapproved = hits.filter((hit) => !COMPATIBILITY_ALLOWLIST.some((rule) => rule.file.test(hit.file) && rule.text.test(hit.text)));

    expect(unapproved).toEqual([]);
  });
});

function collectLegacyIdentityHits(workspaceRoot: string, directory: string): LegacyIdentityHit[] {
  const hits: LegacyIdentityHit[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      hits.push(...collectLegacyIdentityHits(workspaceRoot, absolutePath));
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name)) || /\.(?:test|spec)\.[^.]+$/u.test(entry.name)) continue;
    const file = relative(workspaceRoot, absolutePath).replace(/\\/gu, '/');
    for (const [index, text] of readFileSync(absolutePath, 'utf8').split(/\r?\n/u).entries()) {
      if (/canvasforge/iu.test(text)) hits.push({ file, line: index + 1, text: text.trim() });
    }
  }
  return hits;
}
