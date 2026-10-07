/// <reference path="../../renderer/src/types/pako.d.ts" />
import { createHash } from 'node:crypto';
import type { ImportPreparedLayerRequest, PreparedLayerTarget } from '@agent-canvas/desktop-core/preload-api';
import { decodeLayerPng } from '../../renderer/src/app/layer-png-codec.js';

const signature = [137,80,78,71,13,10,26,10];
const targetKeys = ['projectId', 'nodeId', 'groupId', 'layerId', 'sourceAssetId', 'expectedResultAssetId', 'expectedRevision'];
const maxBytes = 40 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('无效的精修图片请求');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('精修图片请求包含无效字段');
}
function checkHeader(bytes: Uint8Array): { width: number; height: number } {
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || bytes.length > maxBytes) throw new Error('无效的精修图片');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!signature.every((byte, index) => bytes[index] === byte) || !width || !height || width > 8192 || height > 8192
    || width * height > 12_000_000) throw new Error('精修图片尺寸无效');
  return { width, height };
}

export function validatePreparedLayerImportRequest(input: unknown): ImportPreparedLayerRequest {
  const request = record(input); exactKeys(request, ['sessionId', 'bytes', 'layerTarget']);
  if (typeof request.sessionId !== 'string' || !request.sessionId.trim()) throw new Error('无效的精修图片会话');
  const bytes = request.bytes as Uint8Array; checkHeader(bytes);
  if (!('layerTarget' in request)) return { sessionId: request.sessionId, bytes };
  const target = record(request.layerTarget); exactKeys(target, targetKeys);
  if (Object.keys(target).length !== targetKeys.length || targetKeys.slice(0, 5).some(key => typeof target[key] !== 'string' || !(target[key] as string).trim())
    || (target.expectedResultAssetId !== null && (typeof target.expectedResultAssetId !== 'string' || !target.expectedResultAssetId.trim()))
    || !Number.isSafeInteger(target.expectedRevision) || (target.expectedRevision as number) < 0) throw new Error('图层素材替换目标无效');
  return { sessionId: request.sessionId, bytes, layerTarget: target as unknown as PreparedLayerTarget };
}

/** Decode the stored straight channels only for validation. Import saves the
 * original bytes, including RGB under zero/low alpha; no nativeImage/Canvas. */
export function inspectPreparedLayerPng(bytes: Uint8Array) {
  checkHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length) break; // The decoder reports the malformed chunk.
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('分层素材不支持动画 PNG / APNG');
    offset = end;
  }
  const decoded = decodeLayerPng(bytes);
  if (!decoded) throw new Error('请使用完整的 8 位 PNG 图层素材');
  let hasTransparentPixel = false, hasNonzeroPixel = false, opaque = true;
  for (let index = 3; index < decoded.rgba.length; index += 4) {
    const alpha = decoded.rgba[index]!;
    hasTransparentPixel ||= alpha === 0; hasNonzeroPixel ||= alpha > 0; opaque &&= alpha === 255;
  }
  return { width: decoded.width, height: decoded.height, sha256: createHash('sha256').update(bytes).digest('hex'),
    hasTransparentPixel, hasNonzeroPixel, opaque };
}
