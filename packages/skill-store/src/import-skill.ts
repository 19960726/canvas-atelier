import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export interface SkillManifestFile { relativePath: string; sha256: string; }
export interface SkillImportManifest {
  sourceRoot: string;
  managedRoot: string;
  importedAt: string;
  managedCopyVersion: 1;
  files: SkillManifestFile[];
}

export function resolveManagedPath(managedRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error('path is outside managed root');
  const root = resolve(managedRoot);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('path is outside managed root');
  return target;
}

export async function importSkillCopy(
  sourceRoot: string,
  managedRoot: string,
  options: { importedAt?: string } = {},
): Promise<SkillImportManifest> {
  const source = await realpath(sourceRoot);
  const files = (await collectFiles(source)).filter(isAllowedKnowledgeFile).sort();
  const manifestFiles: SkillManifestFile[] = [];

  for (const relativePath of files) {
    const sourcePath = resolve(source, relativePath);
    const resolvedSource = await realpath(sourcePath);
    if (resolvedSource !== source && !resolvedSource.startsWith(`${source}${sep}`)) throw new Error('source path escapes selected root');
    const targetPath = resolveManagedPath(managedRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(resolvedSource, targetPath);
    const content = await readFile(resolvedSource);
    manifestFiles.push({ relativePath: relativePath.replace(/\\/g, '/'), sha256: createHash('sha256').update(content).digest('hex') });
  }

  const manifest: SkillImportManifest = {
    sourceRoot: sourceRoot,
    managedRoot: managedRoot,
    importedAt: options.importedAt ?? new Date().toISOString(),
    managedCopyVersion: 1,
    files: manifestFiles,
  };
  await mkdir(managedRoot, { recursive: true });
  await writeFile(resolveManagedPath(managedRoot, 'skill-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

async function collectFiles(root: string, current = ''): Promise<string[]> {
  const directory = resolve(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const next = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

function isAllowedKnowledgeFile(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  if (/^PROJECT_CHECKPOINT[^/]*\.md$/i.test(normalized)) return true;
  if (/^memory\/.*\.md$/i.test(normalized)) return true;
  if (/^prompts\/.*\.(md|txt)$/i.test(normalized)) return true;
  if (/^skills\/[^/]+\/SKILL\.md$/i.test(normalized)) return true;
  return /^skills\/[^/]+\/references\/.*\.(md|txt)$/i.test(normalized);
}