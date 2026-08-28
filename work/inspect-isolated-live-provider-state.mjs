import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { _electron as electron } from 'playwright';

const workspaceRoot = resolve('.');
const workRoot = resolve('work');
const liveRoot = 'C:/Users/Administrator/AppData/Roaming/Canvas Atelier';
const executablePath = process.argv[2]
  ? resolve(process.argv[2])
  : 'D:/CanvasAtelier/Canvas Atelier/Canvas Atelier.exe';
const tempParent = await mkdtemp(join(workRoot, 'provider-live-diagnostic-'));
if (!tempParent.startsWith(`${workRoot}${sep}`)) throw new Error(`Unsafe temporary path: ${tempParent}`);
const qaRoot = join(tempParent, 'canvasforge-qa-provider-live');
const qaLocalAppData = join(tempParent, 'local-app-data');
const qaRoamingAppData = join(tempParent, 'roaming-app-data');
let electronApp;

try {
  await mkdir(qaRoot, { recursive: true });
  await cp(join(liveRoot, 'Local State'), join(qaRoot, 'Local State'));
  await cp(join(liveRoot, 'IndexedDB'), join(qaRoot, 'IndexedDB'), { recursive: true });
  await cp(join(liveRoot, 'provider-active.json'), join(qaRoot, 'provider-active.json'));
  await cp(join(liveRoot, 'providers', 'relayme'), join(qaRoot, 'providers', 'relayme'), { recursive: true });

  electronApp = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      APPDATA: qaRoamingAppData,
      CANVASFORGE_QA_HIDDEN: '1',
      CANVASFORGE_QA_MODE: '1',
      CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
      LOCALAPPDATA: qaLocalAppData,
    },
  });
  const page = await electronApp.firstWindow();
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const provider = window.novusDesktop?.provider;
    if (!provider) throw new Error('Provider bridge is unavailable.');
    const capture = async (operation) => {
      try {
        return { ok: true, value: await operation() };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    };
    const active = await capture(() => provider.getActiveProvider?.());
    const comflyStatus = await capture(() => provider.getStatus({ provider: 'comfly' }));
    const relayStatus = await capture(() => provider.getStatus({ provider: 'relayme' }));
    const comflyConnection = await capture(() => provider.checkConnection({ provider: 'comfly' }));
    const comflyProfiles = await capture(() => provider.listProfiles({ provider: 'comfly' }));
    const relayConnection = await capture(() => provider.checkConnection({ provider: 'relayme' }));
    const relayProfiles = await capture(() => provider.listProfiles({ provider: 'relayme' }));
    const profiles = relayProfiles.ok ? relayProfiles.value : [];
    const jobs = await new Promise((resolveJobs, rejectJobs) => {
      const request = indexedDB.open('novus-atelier-model-jobs');
      request.onerror = () => rejectJobs(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('jobs', 'readonly');
        const getAll = transaction.objectStore('jobs').getAll();
        getAll.onerror = () => rejectJobs(getAll.error);
        getAll.onsuccess = () => resolveJobs(getAll.result);
      };
    });
    return {
      active,
      comfly: {
        status: comflyStatus,
        connection: comflyConnection,
        profileResult: comflyProfiles.ok ? { ok: true } : comflyProfiles,
        profileCount: comflyProfiles.ok ? comflyProfiles.value.length : 0,
        profiles: comflyProfiles.ok ? comflyProfiles.value.map((profile) => ({
          capabilities: profile.capabilities,
          capabilityStatus: profile.capabilityStatus,
          displayName: profile.displayName,
          modelId: profile.modelId,
          modelRoute: profile.modelRoute,
          provider: profile.provider,
        })) : [],
      },
      relayme: {
        status: relayStatus,
        connection: relayConnection,
        profileResult: relayProfiles.ok ? { ok: true } : relayProfiles,
        profileCount: profiles.length,
        profiles: profiles.map((profile) => ({
          capabilities: profile.capabilities,
          capabilityStatus: profile.capabilityStatus,
          displayName: profile.displayName,
          modelId: profile.modelId,
          modelRoute: profile.modelRoute,
          provider: profile.provider,
        })),
      },
      recentJobs: jobs
        .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')))
        .slice(0, 12)
        .map((job) => ({
          aspectRatio: job.aspectRatio,
          createdAt: job.createdAt,
          error: job.error,
          kind: job.kind,
          modelRoute: job.modelRoute,
          provider: job.provider,
          resolution: job.resolution,
          status: job.status,
          updatedAt: job.updatedAt,
        })),
    };
  });
  await page.getByTestId('settings-toggle').click();
  const catalog = page.getByLabel('模型选择列表');
  await catalog.locator('.settings-model-catalog__summary').waitFor({ timeout: 30_000 });
  result.uiCatalog = {
    summary: await catalog.locator('.settings-model-catalog__summary').innerText(),
    groups: await catalog.locator('.settings-model-group').allInnerTexts(),
  };
  result.uiCatalog.screenshot = await page.screenshot({
    path: join(workRoot, 'release-v1.6.65-real-relayme-catalog.png'),
    timeout: 10_000,
  }).then(() => 'saved').catch(() => 'hidden-window-capture-unavailable');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await electronApp?.close().catch(() => undefined);
  await rm(tempParent, { recursive: true, force: true });
}
