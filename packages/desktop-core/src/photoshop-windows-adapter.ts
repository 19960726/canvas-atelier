import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { PhotoshopImportResult } from './photoshop-contract.js';
import type { PhotoshopSmartObjectAdapter } from './photoshop-smart-object-service.js';
import { createPhotoshopPlacementPayload } from './photoshop-script.js';

const execFileAsync = promisify(execFile);

export interface PhotoshopInstallation {
  readonly majorVersion: number;
  readonly executablePath: string;
}

export interface PhotoshopRunningInstance {
  readonly majorVersion: number;
  readonly activeDocument: boolean;
}

export interface PhotoshopTemporaryFiles {
  readonly directory: string;
  readonly jsxPath: string;
  readonly payloadPath: string;
  readonly runnerPath: string;
}

export type PhotoshopWindowsExecutionResult =
  | { readonly kind: 'success'; readonly layerName: string }
  | { readonly kind: 'automation_denied' }
  | { readonly kind: 'no_active_document' }
  | { readonly kind: 'placement_failed' };

export interface WindowsPhotoshopAdapterDependencies {
  readonly platform: string;
  readonly discoverInstallations: () => Promise<readonly PhotoshopInstallation[]>;
  readonly inspectRunningInstance: () => Promise<PhotoshopRunningInstance | null>;
  readonly execute: (input: PhotoshopTemporaryFiles & {
    readonly installedMajorVersions: readonly number[];
  }) => Promise<PhotoshopWindowsExecutionResult>;
  readonly temporaryFiles: {
    create(input: { readonly absolutePath: string; readonly layerName: string }): Promise<PhotoshopTemporaryFiles>;
    remove(directory: string): Promise<void>;
  };
}

export interface NodeWindowsPhotoshopAdapterOptions {
  readonly platform?: string;
  readonly jsxResourcePath: string;
  readonly runnerResourcePath: string;
}

export function createWindowsPhotoshopSmartObjectAdapter(
  dependencies: WindowsPhotoshopAdapterDependencies,
): PhotoshopSmartObjectAdapter {
  let queue = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    place(input) {
      return enqueue(async (): Promise<PhotoshopImportResult> => {
        if (dependencies.platform !== 'win32') {
          return { ok: false, code: 'desktop_bridge_unavailable' };
        }

        const installations = [...await dependencies.discoverInstallations()]
          .sort((left, right) => right.majorVersion - left.majorVersion);
        if (installations.length === 0) return { ok: false, code: 'photoshop_not_installed' };

        const running = await dependencies.inspectRunningInstance();
        const supportedInstallations = installations.filter((item) => item.majorVersion >= 20);
        if (running !== null && running.majorVersion < 20) {
          return { ok: false, code: 'photoshop_version_unsupported' };
        }
        if (supportedInstallations.length === 0) {
          return { ok: false, code: 'photoshop_version_unsupported' };
        }
        if (running === null) return { ok: false, code: 'photoshop_not_running' };
        if (!running.activeDocument) return { ok: false, code: 'no_active_document' };

        const files = await dependencies.temporaryFiles.create(input);
        try {
          const result = await dependencies.execute({
            ...files,
            installedMajorVersions: supportedInstallations.map((item) => item.majorVersion),
          });
          if (result.kind === 'success') return { ok: true, layerName: result.layerName };
          return { ok: false, code: result.kind };
        } catch {
          return { ok: false, code: 'placement_failed' };
        } finally {
          await dependencies.temporaryFiles.remove(files.directory).catch(() => undefined);
        }
      });
    },
  };
}

export function createNodeWindowsPhotoshopSmartObjectAdapter(
  options: NodeWindowsPhotoshopAdapterOptions,
): PhotoshopSmartObjectAdapter {
  const platform = options.platform ?? process.platform;
  const runCscript = async (args: readonly string[]): Promise<unknown> => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const cscriptPath = join(systemRoot, 'System32', 'cscript.exe');
    const result = await execFileAsync(cscriptPath, ['//B', '//NoLogo', options.runnerResourcePath, ...args], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(result.stdout.trim());
  };

  return createWindowsPhotoshopSmartObjectAdapter({
    platform,
    discoverInstallations: async () => discoverPhotoshopInstallations(platform),
    inspectRunningInstance: async () => {
      if (platform !== 'win32') return null;
      try {
        const value = await runCscript(['--inspect']);
        if (!isRecord(value) || value.kind !== 'running') return null;
        const majorVersion = Number(value.majorVersion);
        return Number.isInteger(majorVersion)
          ? { majorVersion, activeDocument: value.activeDocument === true }
          : null;
      } catch {
        return null;
      }
    },
    execute: async ({ jsxPath, payloadPath }) => {
      try {
        const value = await runCscript([jsxPath, payloadPath]);
        if (!isRecord(value)) return { kind: 'placement_failed' };
        if (value.kind === 'success' && typeof value.layerName === 'string') {
          return { kind: 'success', layerName: value.layerName };
        }
        if (value.kind === 'automation_denied' || value.kind === 'no_active_document') {
          return { kind: value.kind };
        }
        return { kind: 'placement_failed' };
      } catch {
        return { kind: 'placement_failed' };
      }
    },
    temporaryFiles: {
      async create(input) {
        const directory = await mkdtemp(join(tmpdir(), 'novus-photoshop-'));
        const jsxPath = join(directory, basename(options.jsxResourcePath));
        const payloadPath = join(directory, 'payload.json');
        await copyFile(options.jsxResourcePath, jsxPath);
        await writeFile(payloadPath, createPhotoshopPlacementPayload(input), { encoding: 'utf8', flag: 'wx' });
        return { directory, jsxPath, payloadPath, runnerPath: options.runnerResourcePath };
      },
      remove(directory) {
        return rm(directory, { recursive: true, force: true });
      },
    },
  });
}

async function discoverPhotoshopInstallations(platform: string): Promise<PhotoshopInstallation[]> {
  if (platform !== 'win32') return [];
  const registryPaths = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  const installations = new Map<number, PhotoshopInstallation>();
  for (const registryPath of registryPaths) {
    try {
      const result = await execFileAsync('reg.exe', ['query', registryPath, '/s', '/f', 'Adobe Photoshop'], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      for (const line of result.stdout.split(/\r?\n/u)) {
        const match = /Adobe Photoshop(?: CC)?\s+(20\d{2})/iu.exec(line);
        if (match === null) continue;
        const majorVersion = Number(match[1]) - 1999;
        if (majorVersion < 1 || installations.has(majorVersion)) continue;
        installations.set(majorVersion, { majorVersion, executablePath: 'Photoshop.exe' });
      }
    } catch {
      // Missing registry roots and unmatched searches both produce non-zero exits.
    }
  }
  return [...installations.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
