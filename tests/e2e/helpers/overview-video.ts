import type { Page } from '@playwright/test';

export interface OverviewVideoFixtureEvidence {
  readonly mimeType: string;
  readonly byteSize: number;
  readonly metadata: { readonly width: number; readonly height: number; readonly duration: number };
  readonly playback: { readonly readyState: number; readonly videoWidth: number; readonly videoHeight: number; readonly presentedFrames: number; readonly currentTime: number };
  readonly framePixels: readonly number[][];
}

const VIDEO_ROUTE = '**/__novus_e2e_asset/*.mp4';

/**
 * Replaces the empty metadata-only e2e MP4 route with an actual local
 * MediaRecorder output. The output is generated in the browser, decoded in a
 * second video element, then served to the product through its normal asset
 * URL. No provider or network media call is involved.
 */
export async function installOverviewVideoFixture(page: Page): Promise<OverviewVideoFixtureEvidence> {
  const encoded = await page.evaluate(async () => {
    const width = 320;
    const height = 180;
    const candidates = [
      'video/mp4',
      'video/mp4;codecs=avc1.42E01E',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const selectedMime = candidates.find(mime => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime));
    if (!selectedMime) throw new Error('Overview fixture has no supported MediaRecorder MIME');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Overview fixture has no canvas context');
    const paint = (frame: number) => {
      context.fillStyle = '#193d58';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#f04a47';
      context.fillRect(0, 0, width / 2, height / 2);
      context.fillStyle = '#41b57a';
      context.fillRect(width / 2, 0, width / 2, height / 2);
      context.fillStyle = '#4f80df';
      context.fillRect(0, height / 2, width / 2, height / 2);
      context.fillStyle = '#e2b448';
      context.fillRect(width / 2, height / 2, width / 2, height / 2);
      context.fillStyle = '#f4f2da';
      context.fillRect((frame % 8) * width / 10, height * 0.42, width / 5, height * 0.16);
    };
    paint(0);
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, { mimeType: selectedMime, videoBitsPerSecond: 700_000 });
    const chunks: Blob[] = [];
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
      recorder.onstop = () => resolve();
      recorder.onerror = event => reject((event as Event & { readonly error?: DOMException }).error ?? new Error('Overview fixture recorder error'));
    });
    recorder.start(100);
    const timer = window.setInterval(() => paint(performance.now()), 75);
    await new Promise(resolve => setTimeout(resolve, 750));
    window.clearInterval(timer);
    recorder.stop();
    let stopTimeout: number | undefined;
    try {
      await Promise.race([stopped, new Promise<void>((_, reject) => {
        stopTimeout = window.setTimeout(() => reject(new Error('Overview fixture recorder stop timeout')), 10_000);
      })]);
    } finally {
      window.clearTimeout(stopTimeout);
      stream.getTracks().forEach(track => track.stop());
    }
    const blob = new Blob(chunks, { type: recorder.mimeType || selectedMime });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length === 0) throw new Error('Overview fixture recorder produced no bytes');
    const url = URL.createObjectURL(blob);
    const decoder = document.createElement('video');
    decoder.muted = true;
    decoder.playsInline = true;
    decoder.preload = 'auto';
    decoder.style.cssText = 'position:fixed;right:8px;bottom:8px;width:80px;height:45px;object-fit:contain;z-index:5000';
    document.body.append(decoder);
    const metadata = await new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Overview fixture metadata decode timeout')), 10_000);
      decoder.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve({ width: decoder.videoWidth, height: decoder.videoHeight, duration: decoder.duration });
      };
      decoder.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error(`Overview fixture decode error ${decoder.error?.code ?? 'unknown'}`));
      };
      decoder.src = url;
    });
    let presentedFrames = 0;
    const firstFrame = decoder.requestVideoFrameCallback
      ? new Promise<void>(resolve => decoder.requestVideoFrameCallback(() => { presentedFrames += 1; resolve(); }))
      : Promise.resolve();
    await decoder.play();
    await Promise.race([firstFrame, new Promise(resolve => setTimeout(resolve, 1_500))]);
    await new Promise(resolve => setTimeout(resolve, 100));
    const frameCanvas = document.createElement('canvas');
    frameCanvas.width = decoder.videoWidth;
    frameCanvas.height = decoder.videoHeight;
    const frameContext = frameCanvas.getContext('2d', { willReadFrequently: true });
    if (!frameContext) throw new Error('Overview fixture frame context unavailable');
    frameContext.drawImage(decoder, 0, 0);
    const samples = ([[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]] as const)
      .map(([x, y]) => [...frameContext.getImageData(Math.round(decoder.videoWidth * x), Math.round(decoder.videoHeight * y), 1, 1).data]);
    const playback = { readyState: decoder.readyState, videoWidth: decoder.videoWidth, videoHeight: decoder.videoHeight, presentedFrames, currentTime: decoder.currentTime };
    decoder.pause();
    decoder.removeAttribute('src');
    decoder.load();
    decoder.remove();
    URL.revokeObjectURL(url);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return {
      base64: btoa(binary),
      mimeType: blob.type,
      byteSize: bytes.length,
      metadata,
      playback,
      framePixels: samples,
    };
  });
  const bytes = Buffer.from(encoded.base64, 'base64');
  if (!/^video\/mp4(?:;|$)/iu.test(encoded.mimeType) || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') {
    throw new Error(`Overview MP4 fixture unsupported; actual encoder MIME was ${encoded.mimeType}`);
  }
  await page.unroute(VIDEO_ROUTE);
  await page.route(VIDEO_ROUTE, async route => {
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/u);
    if (!range) {
      await route.fulfill({ status: 200, body: bytes, contentType: encoded.mimeType, headers: { 'accept-ranges': 'bytes', 'cache-control': 'no-store' } });
      return;
    }
    const start = Number.parseInt(range[1]!, 10);
    const requestedEnd = range[2] === '' ? bytes.length - 1 : Number.parseInt(range[2]!, 10);
    const end = Math.min(requestedEnd, bytes.length - 1);
    if (start >= bytes.length || end < start) {
      await route.fulfill({ status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
      return;
    }
    await route.fulfill({ status: 206, body: bytes.subarray(start, end + 1), contentType: encoded.mimeType, headers: {
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'content-range': `bytes ${start}-${end}/${bytes.length}`,
    } });
  });
  if (encoded.metadata.width <= 0 || encoded.metadata.height <= 0 || encoded.playback.readyState < 2 || encoded.playback.presentedFrames <= 0 || encoded.playback.currentTime <= 0) {
    throw new Error(`Overview fixture did not decode a presented frame: ${JSON.stringify(encoded.playback)}`);
  }
  return {
    mimeType: encoded.mimeType,
    byteSize: encoded.byteSize,
    metadata: encoded.metadata,
    playback: encoded.playback,
    framePixels: encoded.framePixels,
  };
}
