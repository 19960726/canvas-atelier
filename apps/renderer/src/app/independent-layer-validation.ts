/**
 * Pure, provider-independent checks for a proposed source layer group.
 *
 * The validator intentionally works on full-frame, straight-alpha RGBA. It
 * does not infer ownership from a layer name, bounding box, or a `prepared`
 * flag. Those facts can be useful to the caller when presenting a review, but
 * they are not evidence that a returned matte contains an independent object.
 */

export type IndependentLayerRole = 'foreground' | 'shadow' | 'carrier' | 'unknown';
export type IndependentLayerSource = 'raw' | 'prepared' | 'unknown';
export type IndependentDiagnosticCode = 'source-composite-mismatch' | 'source-contribution-duplicate'
  | 'no-independent-contribution' | 'opaque-source-under-partial' | 'hidden-rgb-unproven' | 'strong-raw-overlap';

export interface IndependentLayerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IndependentLayer {
  id: string;
  name: string;
  role: IndependentLayerRole;
  source: IndependentLayerSource;
  /** Full-frame straight RGBA bytes in source coordinates. */
  rgba: Uint8Array;
  bounds?: IndependentLayerBounds;
  opacity?: number;
}

export interface IndependentLayerValidationInput {
  width: number;
  height: number;
  /** The original, opaque source composite. */
  source: Uint8Array;
  /** The proposed reconstructed background, also in source coordinates. */
  background: Uint8Array;
  /** Bottom-to-top full-frame foreground pixels. */
  foregrounds: readonly IndependentLayer[];
  /** Existing source-matte tolerance. Defaults to one channel value. */
  tolerance?: number;
  /** Existing strong raw entity overlap threshold. Defaults to 35%. */
  strongOverlapThreshold?: number;
}

export interface IndependentLayerGroupResult {
  id: string;
  name: string;
  physicalIndependentRGBA: boolean;
  /** True only where the source RGB can be read without a partial upper contribution. */
  exactOpaqueSourceRgb: boolean;
  semanticReviewRequired: boolean;
  diagnostics: string[];
  diagnosticCodes: IndependentDiagnosticCode[];
  activePixels: number;
  changedPixelsWhenHidden: number;
}

export interface IndependentCompositeResult {
  matchesSource: boolean;
  maxChannelError: number;
  maxAlphaError: number;
  changedPixels: number;
}

export interface IndependentLayerValidationResult {
  /** Physical result. Semantic ownership is reported separately. */
  status: 'pass' | 'reject' | 'review-required';
  /** Names and roles are never proof of ownership; callers should expose this review state. */
  semanticReviewRequired: true;
  composite: IndependentCompositeResult;
  groups: IndependentLayerGroupResult[];
  diagnostics: string[];
  diagnosticCodes: IndependentDiagnosticCode[];
}

const MAX_SIDE = 8_192;
const MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_TOLERANCE = 1;
const DEFAULT_STRONG_OVERLAP = 0.35;

/** Validate a complete source/background/foreground proposal without reading files or calling a provider. */
export function validateIndependentLayerGroup(
  input: IndependentLayerValidationInput,
): IndependentLayerValidationResult {
  const { width, height } = input;
  validateCanvas(width, height);
  const expected = width * height * 4;
  validateRgba('原图', input.source, expected);
  validateRgba('补全背景', input.background, expected);
  if (!input.foregrounds.length) throw new Error('独立分层至少需要一个前景图层');
  if (input.foregrounds.length > 64) throw new Error('独立分层图层数量超过当前验证上限');
  const tolerance = boundedTolerance(input.tolerance);
  const overlapThreshold = boundedOverlap(input.strongOverlapThreshold);
  validateOpaqueSource(input.source);
  validateOpaqueBackground(input.background);
  for (const layer of input.foregrounds) validateLayer(layer, expected, width, height);

  const composite = compose(width, height, input.background, input.foregrounds);
  let maxChannelError = 0;
  let maxAlphaError = 0;
  let compositeChanged = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const error = Math.abs(composite[offset + channel]! - input.source[offset + channel]!);
      maxChannelError = Math.max(maxChannelError, error);
      changed ||= error > tolerance;
    }
    const alphaError = Math.abs(composite[offset + 3]! - input.source[offset + 3]!);
    maxAlphaError = Math.max(maxAlphaError, alphaError);
    changed ||= alphaError > tolerance;
    if (changed) compositeChanged += 1;
  }
  const compositeResult: IndependentCompositeResult = {
    matchesSource: maxChannelError <= tolerance && maxAlphaError <= tolerance,
    maxChannelError,
    maxAlphaError,
    changedPixels: compositeChanged,
  };
  const diagnostics: string[] = [];
  const diagnosticCodes: IndependentDiagnosticCode[] = [];
  if (!compositeResult.matchesSource) {
    diagnostics.push(`全部图层合成与原图不一致（最大颜色误差 ${maxChannelError}，透明度误差 ${maxAlphaError}）`);
    diagnosticCodes.push('source-composite-mismatch');
  }

  const groups = input.foregrounds.map((layer, index) => {
    const hidden = compose(width, height, input.background, input.foregrounds, index);
    const groupDiagnostics: string[] = [];
    const groupDiagnosticCodes: IndependentDiagnosticCode[] = [];
    const activePixels = countActive(layer.rgba);
    let changedPixelsWhenHidden = 0;
    let exactOpaqueSourceRgb = true;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      const alpha = effectiveAlpha(layer, pixel);
      if (!alpha) continue;
      const changed = pixelDiffers(hidden, composite, offset, tolerance);
      if (changed) changedPixelsWhenHidden += 1;
      if (alpha === 255 && hasPartialUpper(input.foregrounds, index, pixel, layer)) {
        exactOpaqueSourceRgb = false;
      }
      // If removing a layer leaves the source unchanged while the layer did
      // affect the stack, another layer/background is carrying or cancelling
      // this layer's pixels. It is not an independently proven contribution.
      if (changed && pixelMatches(hidden, input.source, offset, tolerance)
        && pixelMatches(composite, input.source, offset, tolerance)) {
        groupDiagnostics.push('隐藏该图层后原图仍由其他层/背景复现，存在背景贡献或载体重复');
        groupDiagnosticCodes.push('source-contribution-duplicate');
        break;
      }
    }
    if (!activePixels || !changedPixelsWhenHidden) {
      groupDiagnostics.push('图层没有可独立验证的可见像素，隐藏后原图不发生变化');
      groupDiagnosticCodes.push('no-independent-contribution');
    }
    if (!exactOpaqueSourceRgb) {
      groupDiagnostics.push('不透明源色被上方半透明光学贡献覆盖，独立 RGB 需要人工复核');
      groupDiagnosticCodes.push('opaque-source-under-partial');
    }
    // RGB in transparent pixels is not observable from a single composite.
    // A prepared flag cannot make those hidden colors known.
    if (activePixels === 0) {
      groupDiagnostics.push('图层包含不可见的隐藏 RGB，无法从原图证明归属');
      groupDiagnosticCodes.push('hidden-rgb-unproven');
    }
    const result: IndependentLayerGroupResult = {
      id: layer.id,
      name: layer.name,
      physicalIndependentRGBA: activePixels > 0 && changedPixelsWhenHidden > 0 && groupDiagnostics.length === 0,
      exactOpaqueSourceRgb,
      semanticReviewRequired: true,
      diagnostics: groupDiagnostics,
      diagnosticCodes: groupDiagnosticCodes,
      activePixels,
      changedPixelsWhenHidden,
    };
    return result;
  });

  // Keep the existing conservative rule: only raw source mattes for actual
  // entities participate in the 35% strong-overlap check. Prepared/local
  // pixels still go through all physical checks above and are never exempted.
  const rawEntities = input.foregrounds.filter(layer => layer.source === 'raw' && layer.role !== 'shadow');
  for (let left = 0; left < rawEntities.length; left += 1) {
    for (let right = left + 1; right < rawEntities.length; right += 1) {
      const a = rawEntities[left]!, b = rawEntities[right]!;
      const smaller = Math.min(countStrong(a.rgba), countStrong(b.rgba));
      if (smaller < 16) continue;
      const overlap = strongOverlap(a.rgba, b.rgba);
      if (overlap / smaller <= overlapThreshold) continue;
      const message = `图层“${a.name}”与“${b.name}”的内容重叠 ${Math.round(overlap / smaller * 100)}%；疑似载体重复，请分别检查后再合成`;
      diagnostics.push(message);
      diagnosticCodes.push('strong-raw-overlap');
      for (const group of groups) if (group.id === a.id || group.id === b.id) {
        group.diagnostics.push(message);
        group.diagnosticCodes.push('strong-raw-overlap');
      }
    }
  }

  const hasReject = diagnostics.length > 0 || groups.some(group => group.diagnostics.some(message => /重叠|载体|合成与原图不一致/u.test(message)));
  const hasReview = groups.some(group => !group.physicalIndependentRGBA || !group.exactOpaqueSourceRgb);
  return {
    status: hasReject ? 'reject' : hasReview ? 'review-required' : 'pass',
    semanticReviewRequired: true,
    composite: { ...compositeResult, maxChannelError },
    groups,
    diagnostics,
    diagnosticCodes,
  };
}

function compose(
  width: number,
  height: number,
  background: Uint8Array,
  foregrounds: readonly IndependentLayer[],
  hiddenIndex = -1,
): Uint8Array {
  const output = background.slice();
  for (let index = 0; index < foregrounds.length; index += 1) {
    if (index === hiddenIndex) continue;
    const layer = foregrounds[index]!;
    const opacity = layer.opacity ?? 1;
    if (opacity === 0) continue;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      const sourceAlpha = layer.rgba[offset + 3]! / 255 * opacity;
      if (sourceAlpha <= 0) continue;
      const targetAlpha = output[offset + 3]! / 255;
      const resultAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) {
        output[offset + channel] = Math.round((layer.rgba[offset + channel]! * sourceAlpha
          + output[offset + channel]! * targetAlpha * (1 - sourceAlpha)) / resultAlpha);
      }
      output[offset + 3] = Math.round(resultAlpha * 255);
    }
  }
  return output;
}

function hasPartialUpper(
  layers: readonly IndependentLayer[], index: number, pixel: number, target: IndependentLayer,
): boolean {
  for (let upper = index + 1; upper < layers.length; upper += 1) {
    const layer = layers[upper]!;
    if (layer === target) continue;
    const alpha = effectiveAlpha(layer, pixel);
    if (alpha > 0 && alpha < 255) return true;
  }
  return false;
}

function effectiveAlpha(layer: IndependentLayer, pixel: number): number {
  return Math.round(layer.rgba[pixel * 4 + 3]! * (layer.opacity ?? 1));
}

function countActive(rgba: Uint8Array): number {
  let count = 0;
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index]! > 0) count += 1;
  return count;
}

function countStrong(rgba: Uint8Array): number {
  let count = 0;
  for (let index = 3; index < rgba.length; index += 4) if (rgba[index]! >= 128) count += 1;
  return count;
}

function strongOverlap(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let index = 3; index < a.length; index += 4) if (a[index]! >= 128 && b[index]! >= 128) count += 1;
  return count;
}

function pixelMatches(a: Uint8Array, b: Uint8Array, offset: number, tolerance: number): boolean {
  for (let channel = 0; channel < 4; channel += 1) {
    if (Math.abs(a[offset + channel]! - b[offset + channel]!) > tolerance) return false;
  }
  return true;
}

function pixelDiffers(a: Uint8Array, b: Uint8Array, offset: number, tolerance: number): boolean {
  return !pixelMatches(a, b, offset, tolerance);
}

function validateCanvas(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_SIDE || height > MAX_SIDE || width * height * 4 > MAX_BYTES) {
    throw new Error('独立分层尺寸超出当前验证范围');
  }
}

function validateRgba(label: string, rgba: Uint8Array, expected: number): void {
  if (!(rgba instanceof Uint8Array) || rgba.length !== expected) throw new Error(`${label}像素尺寸无效`);
}

function validateOpaqueSource(source: Uint8Array): void {
  for (let index = 3; index < source.length; index += 4) {
    if (source[index] !== 255) throw new Error('独立分层原图必须是不透明 RGBA');
  }
}

function validateOpaqueBackground(background: Uint8Array): void {
  for (let index = 3; index < background.length; index += 4) {
    if (background[index] !== 255) throw new Error('独立分层补全背景必须是不透明 RGBA');
  }
}

function validateLayer(layer: IndependentLayer, expected: number, width: number, height: number): void {
  if (!layer.id || !layer.name.trim()) throw new Error('独立分层图层身份无效');
  validateRgba(`图层“${layer.name}”`, layer.rgba, expected);
  if (layer.opacity !== undefined && (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1)) {
    throw new Error(`图层“${layer.name}”透明度无效`);
  }
  if (!layer.bounds) return;
  const { x, y, width: layerWidth, height: layerHeight } = layer.bounds;
  if (![x, y, layerWidth, layerHeight].every(Number.isInteger)
    || x < 0 || y < 0 || layerWidth < 1 || layerHeight < 1
    || x + layerWidth > width || y + layerHeight > height) {
    throw new Error(`图层“${layer.name}”位置超出原图范围`);
  }
}

function boundedTolerance(value: number | undefined): number {
  const result = value ?? DEFAULT_TOLERANCE;
  if (!Number.isFinite(result) || result < 0 || result > 32) throw new Error('独立分层颜色容差无效');
  return Math.round(result);
}

function boundedOverlap(value: number | undefined): number {
  const result = value ?? DEFAULT_STRONG_OVERLAP;
  if (!Number.isFinite(result) || result <= 0 || result > 1) throw new Error('独立分层重叠阈值无效');
  return result;
}
