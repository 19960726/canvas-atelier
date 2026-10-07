import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { FileSystem } from './file-system.js';
import { createProviderBridgeError } from './provider-contracts.js';

/** Stable destination for a paid generation result across desktop sessions. */
export interface GenerationProjectBinding {
  readonly projectId: string;
  readonly rootFingerprint: string;
}

export function parseGenerationProjectBinding(value: unknown): GenerationProjectBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidBinding();
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('projectId') || !keys.includes('rootFingerprint')) throw invalidBinding();
  if (typeof record.projectId !== 'string' || record.projectId.length === 0
    || record.projectId !== record.projectId.trim() || record.projectId.length > 256
    || typeof record.rootFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(record.rootFingerprint)) {
    throw invalidBinding();
  }
  return { projectId: record.projectId, rootFingerprint: record.rootFingerprint };
}

export async function fingerprintGenerationProjectRoot(fileSystem: FileSystem, root: string): Promise<string> {
  if (fileSystem.realpath === undefined) throw unavailableRoot();
  let canonical: string;
  try { canonical = resolve(await fileSystem.realpath(root)); }
  catch { throw unavailableRoot(); }
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return createHash('sha256').update('generation-project-root\0').update(normalized).digest('hex');
}

function invalidBinding(): Error {
  return createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generation project binding is invalid');
}

function unavailableRoot(): Error {
  return createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Generation project root is unavailable', true);
}
