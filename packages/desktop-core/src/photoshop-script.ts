export interface PhotoshopPlacementPayloadInput {
  readonly absolutePath: string;
  readonly layerName: string;
}

export function createPhotoshopPlacementPayload(input: PhotoshopPlacementPayloadInput): string {
  return JSON.stringify({
    version: 1,
    imagePathBase64: Buffer.from(input.absolutePath, 'utf8').toString('base64'),
    layerNameBase64: Buffer.from(input.layerName, 'utf8').toString('base64'),
  });
}
