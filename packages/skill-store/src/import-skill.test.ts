import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importSkillCopy, resolveManagedPath } from './import-skill';

describe('importSkillCopy', () => {
  it('copies only approved Skill knowledge files and records hashes', async () => {
    const source = await mkdtemp(join(tmpdir(), 'scene-skill-source-'));
    const managed = await mkdtemp(join(tmpdir(), 'scene-skill-managed-'));
    await mkdir(join(source, 'memory'), { recursive: true });
    await mkdir(join(source, 'skills', 'scene', 'references'), { recursive: true });
    await mkdir(join(source, 'output'), { recursive: true });
    await writeFile(join(source, 'memory', 'main-memory.md'), '# memory', 'utf8');
    await writeFile(join(source, 'skills', 'scene', 'SKILL.md'), '# skill', 'utf8');
    await writeFile(join(source, 'skills', 'scene', 'references', 'rules.md'), '# rules', 'utf8');
    await writeFile(join(source, 'PROJECT_CHECKPOINT.md'), '# checkpoint', 'utf8');
    await writeFile(join(source, 'output', 'private.png'), 'not copied', 'utf8');

    const manifest = await importSkillCopy(source, managed, { importedAt: '2026-07-13T12:00:00.000Z' });

    expect(manifest).toMatchObject({ sourceRoot: source, managedCopyVersion: 1, importedAt: '2026-07-13T12:00:00.000Z' });
    expect(manifest.files.map((file) => file.relativePath).sort()).toEqual([
      'PROJECT_CHECKPOINT.md',
      'memory/main-memory.md',
      'skills/scene/SKILL.md',
      'skills/scene/references/rules.md',
    ]);
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    await expect(readFile(join(managed, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('# memory');
    await expect(readFile(join(managed, 'output', 'private.png'), 'utf8')).rejects.toThrow();
  });

  it('rejects managed paths that escape the selected root', () => {
    expect(() => resolveManagedPath('C:\\managed', '..\\escape.md')).toThrow(/outside managed root/);
  });
});