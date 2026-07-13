export type MemoryDiffState = 'unchanged' | 'app_changed' | 'source_changed' | 'conflict';
export interface MemoryDiffEntry { relativePath: string; state: MemoryDiffState; base?: string; app?: string; source?: string; }

export function computeMemoryDiff(
  baseFiles: Record<string, string>,
  appFiles: Record<string, string>,
  sourceFiles: Record<string, string>,
): MemoryDiffEntry[] {
  const paths = Array.from(new Set([...Object.keys(baseFiles), ...Object.keys(appFiles), ...Object.keys(sourceFiles)])).sort();
  return paths.map((relativePath) => {
    const base = baseFiles[relativePath];
    const app = appFiles[relativePath];
    const source = sourceFiles[relativePath];
    let state: MemoryDiffState;
    if (app === base && source === base) state = 'unchanged';
    else if (app !== base && source === base) state = 'app_changed';
    else if (app === base && source !== base) state = 'source_changed';
    else if (app === source) state = 'app_changed';
    else state = 'conflict';
    return { relativePath, state, base, app, source };
  });
}