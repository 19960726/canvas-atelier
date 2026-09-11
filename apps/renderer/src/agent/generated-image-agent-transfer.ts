const queuedGeneratedImageAssetIds: string[] = [];

export function queueGeneratedImageForAgent(assetId: string): void {
  if (assetId.length === 0) return;
  const existingIndex = queuedGeneratedImageAssetIds.indexOf(assetId);
  if (existingIndex >= 0) queuedGeneratedImageAssetIds.splice(existingIndex, 1);
  queuedGeneratedImageAssetIds.push(assetId);
  if (queuedGeneratedImageAssetIds.length > 20) queuedGeneratedImageAssetIds.shift();
  // The action menu lives above the canvas. Let its click finish before
  // opening Agent, otherwise the same bubbling click closes the surface again.
  globalThis.setTimeout(() => {
    globalThis.dispatchEvent(new CustomEvent('novus:open-agent'));
    globalThis.setTimeout(() => {
      globalThis.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId } }));
    }, 0);
  }, 0);
}

export function listQueuedGeneratedImagesForAgent(): readonly string[] {
  return [...queuedGeneratedImageAssetIds];
}

export function consumeQueuedGeneratedImageForAgent(assetId: string): void {
  const index = queuedGeneratedImageAssetIds.indexOf(assetId);
  if (index >= 0) queuedGeneratedImageAssetIds.splice(index, 1);
}
