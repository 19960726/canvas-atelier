import { posix, win32, type PlatformPath } from 'node:path';

type QaEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveQaUserDataRoot(
  env: QaEnvironment,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (env.CANVASFORGE_QA_MODE !== '1') return null;
  const candidate = env.CANVASFORGE_QA_USER_DATA_ROOT?.trim();
  if (!candidate) return null;
  const pathApi: PlatformPath = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(candidate)) return null;
  const normalized = pathApi.normalize(candidate);
  const directoryName = pathApi.basename(normalized).toLocaleLowerCase();
  if (!directoryName.includes('canvasforge-qa')) return null;
  return normalized;
}

export function shouldShowQaWindow(env: QaEnvironment): boolean {
  return !(env.CANVASFORGE_QA_MODE === '1' && env.CANVASFORGE_QA_HIDDEN === '1');
}
