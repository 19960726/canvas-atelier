import { _electron as electron } from 'playwright';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const username = process.env.RELAYME_E2E_USERNAME;
const password = process.env.RELAYME_E2E_PASSWORD;
if (!username || !password) throw new Error('RelayMe live acceptance credentials are required');

const executablePath = resolve(process.argv[2] ?? 'apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe');
const qaRoot = process.argv[3]
  ? resolve(process.argv[3])
  : resolve(tmpdir(), 'canvasforge-qa-relayme-live-1.6.84');
const pageErrors = [];
const electronApp = await electron.launch({
  executablePath,
  env: {
    ...process.env,
    CANVASFORGE_QA_HIDDEN: '1',
    CANVASFORGE_QA_MODE: '1',
    CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
  },
});

try {
  const page = await electronApp.firstWindow();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForSelector('[data-testid="workspace"]', { timeout: 20_000 });
  const result = await page.evaluate(async ({ username, password }) => {
    const bridge = window.novusDesktop;
    if (!bridge) throw new Error('Desktop bridge is unavailable');
    let stage = 'create_project';
    try {
      const projectId = crypto.randomUUID();
      const session = await bridge.createProject({
        project: {
          version: 1,
          graphVersion: 2,
          id: projectId,
          name: 'RelayMe live acceptance',
          nodes: [],
          edges: [],
          projectMemory: [],
          skillPromotionCandidates: [],
        },
      });
      if (!session) throw new Error('QA project session was not created');

      stage = 'login';
      const active = await bridge.provider.loginRelayMe({ username, password });
      stage = 'list_profiles';
      const profiles = await bridge.provider.listProfiles({ provider: 'relayme' });
      const imageProfile = profiles.find((profile) => profile.modelId === 'gpt-image-2'
        && profile.capabilities.includes('image_generation'));
      if (!imageProfile) throw new Error('gpt-image-2 profile is unavailable');
      const videoProfile = profiles.find((profile) => profile.modelId === 'Veo 3.1 Fast'
        && profile.capabilities.includes('video_generation'));
      if (!videoProfile) throw new Error('Veo 3.1 Fast profile is unavailable');

      stage = 'submit_image';
      const submitted = await bridge.provider.submitImageJob({
      jobId: `live-${crypto.randomUUID()}`,
      provider: 'relayme',
      modelRoute: imageProfile.modelRoute,
      prompt: 'A simple professional test image: a teal square centered on a clean white background, no text',
      conversationId: `live-${crypto.randomUUID()}`,
      sessionId: session.sessionId,
      referenceAssetIds: [],
      aspectRatio: '1:1',
      resolution: '1K',
      outputCount: 1,
    });

      stage = 'poll_image';
      let terminal;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 3_000));
        const polled = await bridge.provider.pollImageJob({
          provider: 'relayme',
          providerTaskId: submitted.providerTaskId,
        });
        if (polled.status !== 'running') {
          terminal = polled;
          break;
        }
      }
      if (!terminal || terminal.status !== 'completed') {
        throw new Error(`Canvas image job did not complete: ${terminal?.status ?? 'timeout'}`);
      }
      stage = 'list_project_images';
      const images = await bridge.projectImages.list({ sessionId: session.sessionId });
      const generated = images.find((image) => image.assetId === terminal.result.assetId);
      if (!generated) throw new Error('Generated image was not committed to the QA project');
      stage = 'photoshop_import';
      const photoshop = await bridge.projectImages.importToPhotoshop({
        sessionId: session.sessionId,
        assetId: generated.assetId,
      });

      stage = 'submit_video';
      const videoSubmitted = await bridge.provider.submitVideoJob({
        jobId: `live-video-${crypto.randomUUID()}`,
        provider: 'relayme',
        modelRoute: videoProfile.modelRoute,
        prompt: 'A static teal square centered on a clean white background, minimal motion, no text',
        conversationId: `live-video-${crypto.randomUUID()}`,
        sessionId: session.sessionId,
        referenceAssetIds: [],
        durationSeconds: 4,
        outputCount: 1,
        audioEnabled: false,
      });
      stage = 'poll_video';
      let videoTerminal;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 3_000));
        const polled = await bridge.provider.pollVideoJob({
          provider: 'relayme',
          providerTaskId: videoSubmitted.providerTaskId,
        });
        if (polled.status !== 'running') {
          videoTerminal = polled;
          break;
        }
      }
      if (!videoTerminal || videoTerminal.status !== 'completed') {
        throw new Error(`Canvas video job did not complete: ${videoTerminal?.status ?? 'timeout'}`);
      }
      stage = 'list_project_videos';
      const videos = await bridge.projectVideos.list({ sessionId: session.sessionId });
      const generatedVideo = videos.find((video) => video.assetId === videoTerminal.result.assetId);
      if (!generatedVideo) throw new Error('Generated video was not committed to the QA project');
      return {
        ok: true,
        activeProvider: active.activeProvider,
        modelCount: profiles.length,
        modelRoute: imageProfile.modelRoute,
        taskStatus: terminal.status,
        assetId: generated.assetId,
        mediaType: generated.mediaType,
        width: terminal.result.width,
        height: terminal.result.height,
        photoshop,
        videoModelRoute: videoProfile.modelRoute,
        videoTaskStatus: videoTerminal.status,
        videoAssetId: generatedVideo.assetId,
        videoMediaType: generatedVideo.mediaType,
        videoDurationSeconds: videoTerminal.result.durationSeconds,
      };
    } catch (error) {
      return {
        ok: false,
        stage,
        error: {
          code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '',
          message: typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error),
          retryable: typeof error === 'object' && error !== null && 'retryable' in error ? error.retryable === true : false,
        },
      };
    }
  }, { username, password });

  const version = await electronApp.evaluate(({ app }) => app.getVersion());
  process.stdout.write(`${JSON.stringify({ version, ...result, pageErrors })}\n`);
  if (!result.ok) throw new Error(`Live acceptance failed at ${result.stage}: ${result.error.code} ${result.error.message}`);
  if (version !== '1.6.84'
    || result.activeProvider !== 'relayme'
    || result.modelCount < 1
    || result.taskStatus !== 'completed'
    || result.mediaType !== 'image/png'
    || result.videoTaskStatus !== 'completed'
    || result.videoMediaType !== 'video/mp4'
    || pageErrors.length > 0) process.exitCode = 1;
} finally {
  process.env.RELAYME_E2E_USERNAME = '';
  process.env.RELAYME_E2E_PASSWORD = '';
  await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
}
