import { describe, expect, it } from 'vitest';
import { computeMemoryDiff } from './memory-diff';

describe('computeMemoryDiff', () => {
  it('classifies unchanged, app changes, source changes, and conflicts', () => {
    expect(computeMemoryDiff(
      { 'same.md': 'a', 'app.md': 'base', 'source.md': 'base', 'conflict.md': 'base' },
      { 'same.md': 'a', 'app.md': 'app', 'source.md': 'base', 'conflict.md': 'app' },
      { 'same.md': 'a', 'app.md': 'base', 'source.md': 'source', 'conflict.md': 'source' },
    )).toEqual([
      { relativePath: 'app.md', state: 'app_changed', base: 'base', app: 'app', source: 'base' },
      { relativePath: 'conflict.md', state: 'conflict', base: 'base', app: 'app', source: 'source' },
      { relativePath: 'same.md', state: 'unchanged', base: 'a', app: 'a', source: 'a' },
      { relativePath: 'source.md', state: 'source_changed', base: 'base', app: 'base', source: 'source' },
    ]);
  });
});