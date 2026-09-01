import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';

const sourceUserData = 'C:\\Users\\Administrator\\AppData\\Roaming\\Canvas Atelier';
const sourceProject = join(sourceUserData, 'projects', '74025695-1a11-47e5-91b3-ef0b4456baee.novus-project');
const executablePath = resolve(process.argv[2] ?? 'apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe');
const requestedAssetId = process.argv[3];
const qaRoot = await mkdtemp(join(tmpdir(), 'canvasforge-qa-video-playback-'));
const qaProject = join(qaRoot, 'projects', '74025695-1a11-47e5-91b3-ef0b4456baee.novus-project');
let app;
try {
  await cp(sourceProject, qaProject, { recursive: true });
  const index = JSON.parse(await readFile(join(sourceUserData, 'recent-projects.index.json'), 'utf8'));
  index.entries[0].root = qaProject;
  index.entries[0].recentProjectId = `recent_${createHash('sha256').update(normalize(qaProject).replace(/\\\\/gu, '/').toLocaleLowerCase('en-US')).digest('hex').slice(0, 24)}`;
  await writeFile(join(qaRoot, 'recent-projects.index.json'), JSON.stringify(index), 'utf8');
  app = await electron.launch({
    executablePath,
    env: { ...process.env, CANVASFORGE_QA_HIDDEN: '1', CANVASFORGE_QA_MODE: '1', CANVASFORGE_QA_USER_DATA_ROOT: qaRoot },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 20_000 });
  const opened = await page.evaluate(async (requestedAssetId) => {
    const api = window.novusDesktop;
    if (api === undefined) throw new Error('Desktop bridge unavailable');
    const recent = await api.recentProjects.list();
    if (recent[0] === undefined) throw new Error('Saved project unavailable');
    const project = await api.recentProjects.open({ recentProjectId: recent[0].recentProjectId, mode: 'write' });
    if (project === null) throw new Error('Saved project failed to open');
    const videos = await api.projectVideos.list({ sessionId: project.sessionId });
    const selectedVideo = requestedAssetId === undefined
      ? videos[0]
      : videos.find((video) => video.assetId === requestedAssetId);
    if (selectedVideo === undefined) throw new Error('Saved project has no matching video');
    const element = document.createElement('video');
    element.id = 'qa-saved-video';
    element.src = selectedVideo.displayUrl;
    element.controls = true;
    element.muted = true;
    document.body.append(element);
    return { assetId: selectedVideo.assetId, displayUrl: selectedVideo.displayUrl, nodeCount: project.project.nodes.length };
  }, requestedAssetId);
  const video = page.locator('#qa-saved-video');
  await video.waitFor({ state: 'attached', timeout: 20_000 });
  const before = await video.evaluate((element) => ({ duration: element.duration, readyState: element.readyState, currentTime: element.currentTime, error: element.error?.message ?? null }));
  await video.evaluate(async (element) => { element.muted = true; await element.play(); });
  await page.waitForTimeout(1_200);
  const after = await video.evaluate((element) => ({ duration: element.duration, readyState: element.readyState, currentTime: element.currentTime, paused: element.paused, error: element.error?.message ?? null }));
  process.stdout.write(`${JSON.stringify({ before, after, errors, opened, version: await app.evaluate(({ app: electronApp }) => electronApp.getVersion()) })}\n`);
  if (!(after.currentTime > before.currentTime && after.error === null)) process.exitCode = 1;
} finally {
  await app?.close().catch(() => undefined);
  await rm(qaRoot, { recursive: true, force: true });
}
