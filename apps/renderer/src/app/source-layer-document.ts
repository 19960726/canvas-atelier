import { extractOriginalLayer } from './source-layer-pixels';
import { applyLayerSelection, type LayeringBox, type LayeringSelection } from './layering-selection';
import { composeLayeredRgba, trimTransparentLayer, type LayeredPsdDocument, type LayeredPsdLayer } from './layered-psd';
import {repairLayerBackground,extractShadowResidual} from './layer-background-repair';
import { validateIndependentLayerGroup, type IndependentLayer } from './independent-layer-validation';
import { encodeDraftPsd } from './encode-draft-psd';

export interface SourcePixelLayer {
  id: string; name: string; kind: 'background' | 'transparent'; visible: boolean; opacity: number;
  bounds?: LayeringBox;
  maskSpace?: 'source' | 'bounds';
  preparedRgb?: boolean;
  /** A v2 result carrying straight RGBA bytes which still needs semantic review. */
  independentRgbaCandidate?: boolean;
  rgbaCandidateOrigin?: 'provider-v2' | 'local-rgba-import';
  representationError?: string;
  semanticReviewAccepted?: boolean;
  semanticReviewDigest?: string;
  layeringConfirmationDigest?: string;
  shadowOnly?: boolean;
  /** The confirmed job contract, kept separate from provider wording. */
  outputContract?: 'source-alpha-matte-v1' | 'source-independent-rgba-v2' | 'opaque-background-v2';
  load: () => Promise<Uint8Array>;
}

/** Decode masks one at a time, retain original placement and trim only transparent padding. */
export async function buildSourceLayerDocument(input: {
  width: number; height: number; source: Uint8Array; selection: LayeringSelection; layers: readonly SourcePixelLayer[];
  backgroundMode?: 'preserve' | 'replace';
  /** Run the provider-independent full-frame group check before PSD/preview use. */
  independentValidation?: 'strict' | 'audit';
  /** Confirmation binding for the current ordered layer group. */
  groupConfirmationDigest?: string;
  /** Set when the plan or layer provenance changed after the last confirmation. */
  needsReconfirm?: boolean;
}): Promise<LayeredPsdDocument> {
  const { width, height, source, layers, selection } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
    || source.length !== width * height * 4 || source.length > 128 * 1024 * 1024) throw new Error('原图尺寸超出当前分层处理范围');
  if (layers.length < 2 || layers[0]?.kind !== 'background' || layers.slice(1).some(layer => layer.kind !== 'transparent')) throw new Error('分层记录需要一个背景和至少一个前景');
  for (let i = 3; i < source.length; i += 4) if (source[i] !== 255) throw new Error('原图像素分层需要不透明原图，请先合成背景');
  if (layers.slice(1).some(layer => !layer.bounds)) throw new Error('请先标注每个图层在原图中的位置');
  if (input.backgroundMode === 'replace' && selection.mode !== 'whole') throw new Error('完整补全背景只适用于整图分层');
  for (const layer of layers) if (layer.representationError) throw new Error(layer.representationError);
  if (input.independentValidation === 'strict') {
    // The independent validator starts from an opaque background. Its result
    // can certify the returned PSD only when that layer also composes at 1.
    if (layers[0]!.opacity !== 1) throw new Error('原图分层正式合成需要不透明背景，背景图层透明度必须为 100%');
    validateStrictSourceBinding(input);
    if (input.backgroundMode === 'replace') validateBackgroundReplacementPermission(input);
  }
  const generated = await layers[0]!.load();
  if (generated.length !== source.length) throw new Error('背景补全尺寸与原图不一致');
  if (input.backgroundMode === 'replace') for (let p = 3; p < generated.length; p += 4) {
    if (generated[p] !== 255) throw new Error('完整补全背景包含透明空洞，请检查背景层');
  }
  const coverage = new Uint8Array(width * height);
  const foregrounds: LayeredPsdLayer[] = [];
  const objects=layers.slice(1).filter(layer=>!layer.shadowOnly || isIndependentRgba(layer));
  const partialAbove = new Uint8Array(width * height);
  const rawPartialAbove = new Uint8Array(width * height);
  let unresolvedTransparency: { lower: SourcePixelLayer; upper: SourcePixelLayer; refinement: SourcePixelLayer } | undefined;
  let unmatchedBackground: SourcePixelLayer | undefined;
  let fullyCovered: SourcePixelLayer | undefined;
  const providerMasks: { layer: SourcePixelLayer; pixels: number; index: number }[] = [];
  const providerIntersections: Uint32Array[] = [];
  let providerOwners: Uint32Array | undefined;
  // Provider source-space mattes must reconstruct original pixels when all
  // layers are visible. Use the donor only under actual foreground coverage;
  // applying donor feathering outside those mattes visibly changes the image.
  // Locally prepared RGB layers use the separate donor repair path.
  const repair=objects.length>0&&objects.every(layer=>isIndependentRgba(layer));
  // Only legacy raw shadows below the trusted foreground stack need the old
  // residual estimator. Prepared shadow RGBA is already independently known.
  const residualShadows = repair ? layers.slice(1).filter(layer => layer.shadowOnly && !isIndependentRgba(layer)
    && objects.every(object => layers.indexOf(object) > layers.indexOf(layer))) : [];
  let totalBytes = source.length;
  // Legacy source-color masks must not duplicate the same source object into
  // lower layers. Prepared foreground RGBA is already separated and must keep
  // its own pixels so transparency and visibility remain independently editable.
  const processingOrder=[...layers.slice(1)].reverse();
  if (processingOrder.length >= 255) throw new Error('独立图层数量超过透明贡献检查上限');
  for (const layer of processingOrder) {
    const owner = processingOrder.indexOf(layer) + 1;
    const residualShadow = residualShadows.includes(layer);
    const mask = await layer.load();
    if (mask.length !== source.length) throw new Error('图层像素尺寸与原图不一致');
    let rgba: Uint8Array;
    try {
      rgba = applyLayerSelection(isIndependentRgba(layer) ? mask.slice()
        : extractOriginalLayer(source, mask, width, height, layer.bounds!, residualShadow ? 'source' : layer.maskSpace), width, height, selection);
    } catch (error) {
      throw new Error(`图层“${layer.name}”：${error instanceof Error ? error.message : '原图像素提取失败'}`);
    }
    if (!rgba.some((value, index) => index % 4 === 3 && value > 0)) throw new Error(`图层“${layer.name}”在所选范围内没有可见像素，请校正原图位置`);
    if (!isIndependentRgba(layer) && !layer.shadowOnly && layer.maskSpace === 'source') {
      // Format and placement checks cannot tell whether two returned mattes
      // contain the same object. Measure their original coverage before the
      // export order removes duplicate pixels and hides the provider error.
      const index = providerMasks.length;
      if (index >= 31) throw new Error('独立图层数量超过内容重叠检查上限');
      const owners = providerOwners ??= new Uint32Array(width * height);
      const intersections = new Uint32Array(index);
      let pixels = 0;
      for (let pixel = 0; pixel < owners.length; pixel++) {
        if (rgba[pixel * 4 + 3]! < 128) continue;
        const previous = owners[pixel]!;
        for (let prior = 0; prior < index; prior++) if (previous & (1 << prior)) intersections[prior]!++;
        owners[pixel] = previous | (1 << index);
        pixels++;
      }
      providerMasks.push({ layer, pixels, index });
      providerIntersections.push(intersections);
    }
    for (let i = 0; i < coverage.length; i++) {
      const offset = i * 4;
      if (!rgba[offset + 3]) continue;
      if (partialAbove[i] !== 255) {
        const rawSource = !isIndependentRgba(layer) && layer.maskSpace === 'source';
        const previous = rawSource ? partialAbove[i]! : rawPartialAbove[i]!;
        if (previous && !unresolvedTransparency) {
          const upper = processingOrder[previous - 1]!;
          unresolvedTransparency = { lower: layer, upper, refinement: rawSource ? layer : upper };
        }
        // 255 means an opaque upper layer already hides lower source pixels.
        // Otherwise raw colors cannot be recovered independently from a
        // composite that also contains another translucent contribution.
        if (rgba[offset + 3] === 255) {
          partialAbove[i] = 255;
          rawPartialAbove[i] = 0;
        } else {
          if (!partialAbove[i]) partialAbove[i] = owner;
          if (rawSource && !rawPartialAbove[i]) rawPartialAbove[i] = owner;
        }
      }
      if (coverage[i] && !isIndependentRgba(layer)) rgba.fill(0, offset, offset + 4);
      else {
        if (!residualShadow) coverage[i] = 1;
        if (generated[offset + 3] !== 255) throw new Error('补全背景包含透明空洞，请重新检查背景层');
        if (!isIndependentRgba(layer) && layer.maskSpace === 'source' && rgba[offset + 3]! < 255) {
          // C = alpha * F + (1-alpha) * B. Copying C straight into a
          // translucent layer bakes the old backdrop in a second time.
          const alpha = rgba[offset + 3]! / 255;
          let mismatch = false;
          const corrected = [0, 1, 2].map(channel => Math.max(0, Math.min(255, Math.round(
            (source[offset + channel]! - (1 - alpha) * generated[offset + channel]!) / alpha))));
          for (let channel = 0; channel < 3; channel++) {
            if (Math.abs(Math.round(alpha * corrected[channel]! + (1 - alpha) * generated[offset + channel]!)
              - source[offset + channel]!) > 1) mismatch = true;
          }
          if (mismatch) {
            unmatchedBackground ??= layer;
          } else {
            for (let channel = 0; channel < 3; channel++) rgba[offset + channel] = corrected[channel]!;
          }
        }
      }
    }
    if (!isIndependentRgba(layer) && !layer.shadowOnly && layer.maskSpace === 'source'
      && !rgba.some((value, index) => index % 4 === 3 && value > 0)) {
      fullyCovered ??= layer;
    }
    if (residualShadow) continue;
    const trimmed = trimTransparentLayer({ ...layer, x: 0, y: 0, width, height, rgba });
    totalBytes += trimmed.rgba.length;
    if (totalBytes > 256 * 1024 * 1024) throw new Error('图层像素总量超过当前 PSD 导出内存上限（256 MiB）');
    foregrounds.unshift(trimmed);
  }
  const orderedProviderMasks = providerMasks.sort((a, b) => objects.indexOf(a.layer) - objects.indexOf(b.layer));
  for (let a = 0; a < orderedProviderMasks.length; a++) for (let b = a + 1; b < orderedProviderMasks.length; b++) {
    const left = orderedProviderMasks[a]!, right = orderedProviderMasks[b]!, smaller = Math.min(left.pixels, right.pixels);
    if (smaller < 16) continue;
    const later = Math.max(left.index, right.index), earlier = Math.min(left.index, right.index);
    const overlap = providerIntersections[later]![earlier]!;
    if (overlap > smaller * .35) throw new Error(`图层“${left.layer.name}”与“${right.layer.name}”的内容重叠 ${Math.round(overlap / smaller * 100)}%；返图混入其他物体，请分别检查并本地精修后再合成`);
  }
  if (unresolvedTransparency) {
    const { lower, upper, refinement } = unresolvedTransparency;
    throw new Error(`图层“${lower.name}”与“${upper.name}”的透明贡献叠加，当前原图与蒙版无法确定独立颜色；请先本地精修图层“${refinement.name}”为独立前景后再合成，或导出待修整 PSD。已有返图已保留。`);
  }
  if (unmatchedBackground) throw backgroundMismatchError(unmatchedBackground);
  if (fullyCovered) throw new Error(`图层“${fullyCovered.name}”内容重叠，导出后已被其他图层完全覆盖，没有独立可见像素；请校对遮挡关系或本地精修后再合成`);
  let background:Uint8Array = source.slice();
  for (let i = 0; i < coverage.length; i++) {
    if (!coverage[i]) continue;
    const offset = i * 4;
    if (generated[offset + 3] !== 255) throw new Error('补全背景包含透明空洞，请重新检查背景层');
    background.set(generated.subarray(offset, offset + 4), offset);
  }
  if(repair){
    const erased=coverage.slice(),excluded=coverage.slice();
    for(const layer of residualShadows){
      const b=layer.bounds!;
      for(let y=Math.floor(b.y*height);y<Math.min(height,Math.ceil((b.y+b.height)*height));y++)for(let x=Math.floor(b.x*width);x<Math.min(width,Math.ceil((b.x+b.width)*width));x++)erased[y*width+x]=1;
    }
    for(let p=0;p<erased.length;p++)if(erased[p]&&generated[p*4+3]!==255)throw new Error('补全背景包含透明空洞，请重新检查背景层');
    // A locally imported background already carries its explicitly repaired
    // hidden pixels. Preserve them; provider donors retain the legacy repair.
    background=input.backgroundMode === 'replace' || layers[0]!.rgbaCandidateOrigin === 'local-rgba-import'
      ? generated.slice() : repairLayerBackground(source,generated,width,height,erased);
    // Donor feathering is useful beneath a removed object, but its correction
    // field must not repaint nearby pixels that no foreground actually covers.
    if (input.backgroundMode !== 'replace') for (let pixel = 0; pixel < erased.length; pixel++) {
      if (!erased[pixel]) background.set(source.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
    }
    background=applyLayerSelection(background,width,height,selection,source);
    for(const layer of [...residualShadows].reverse()){
      const rgba=applyLayerSelection(extractShadowResidual(source,background,width,height,layer.bounds!,excluded),width,height,selection);
      for(let p=0;p<excluded.length;p++)if(rgba[p*4+3])excluded[p]=1;
      const trimmed=trimTransparentLayer({...layer,x:0,y:0,width,height,rgba});
      totalBytes+=trimmed.rgba.length;
      if(totalBytes>256*1024*1024)throw new Error('图层像素总量超过当前 PSD 导出内存上限（256 MiB）');
      foregrounds.push(trimmed);
    }
  }
  if (input.backgroundMode === 'replace' && !repair) background = generated.slice();
  foregrounds.sort((a,b)=>layers.findIndex(layer=>layer.id===a.id)-layers.findIndex(layer=>layer.id===b.id));
  const document = { width, height, layers: [{ ...layers[0]!, x: 0, y: 0, width, height, rgba: background }, ...foregrounds] };
  if (input.independentValidation !== undefined) validateAssembledSourceGroup(input, document);
  return document;
}

const confirmationDigestPattern = /^[a-f0-9]{64}$/u;

/**
 * Prepared RGB and an independent candidate both contain straight RGBA bytes.
 * Candidate status is intentionally separate: v2 merely describes the bytes,
 * while semantic review and the group confirmation are the trust boundary.
 */
function isIndependentRgba(layer: Pick<SourcePixelLayer, 'preparedRgb' | 'independentRgbaCandidate' | 'rgbaCandidateOrigin' | 'outputContract'>): boolean {
  return layer.preparedRgb === true
    || (layer.independentRgbaCandidate === true && (layer.rgbaCandidateOrigin === 'local-rgba-import'
      || layer.outputContract === 'source-independent-rgba-v2'));
}

function validateStrictSourceBinding(input: {
  layers: readonly SourcePixelLayer[];
  groupConfirmationDigest?: string;
  needsReconfirm?: boolean;
}): void {
  if (input.needsReconfirm === true) {
    throw new Error('分层方案已变更，请重新确认后再合成 PSD');
  }
  const groupDigest = input.groupConfirmationDigest;
  if (groupDigest !== undefined && !confirmationDigestPattern.test(groupDigest)) {
    throw new Error('分层确认摘要格式无效，必须是 64 位小写十六进制 digest');
  }
  for (const layer of input.layers) {
    if (!layer.independentRgbaCandidate) continue;
    if (layer.rgbaCandidateOrigin !== 'local-rgba-import' && layer.outputContract !== 'source-independent-rgba-v2') {
      throw new Error(`图层“${layer.name}”的独立 RGBA 候选缺少 source-independent-rgba-v2 合同，不能正式合成 PSD`);
    }
    if (layer.semanticReviewAccepted !== true) {
      throw new Error(`图层“${layer.name}”的独立 RGBA 候选尚未完成核验，不能正式合成 PSD`);
    }
    const semanticDigest = layer.semanticReviewDigest;
    if (semanticDigest === undefined || !confirmationDigestPattern.test(semanticDigest)) {
      throw new Error(`图层“${layer.name}”缺少有效的语义核验摘要，不能正式合成 PSD`);
    }
    if (groupDigest !== undefined && semanticDigest !== groupDigest) {
      throw new Error(`图层“${layer.name}”的语义核验摘要与当前分层确认摘要不匹配，请重新确认`);
    }
  }
  if (groupDigest !== undefined) {
    for (const layer of input.layers) {
      if (layer.layeringConfirmationDigest !== groupDigest) {
        throw new Error(`图层“${layer.name}”的分层确认摘要已过期，请重新确认后再合成 PSD`);
      }
    }
  }
}

function validateAssembledSourceGroup(
  input: { width: number; height: number; source: Uint8Array; layers: readonly SourcePixelLayer[];
    independentValidation?: 'strict' | 'audit'; backgroundMode?: 'preserve' | 'replace';
    groupConfirmationDigest?: string; needsReconfirm?: boolean },
  document: LayeredPsdDocument,
): void {
  const sourceById = new Map(input.layers.map(layer => [layer.id, layer]));
  const foregrounds: IndependentLayer[] = document.layers.slice(1).map(layer => {
    const original = sourceById.get(layer.id);
    return {
      id: layer.id,
      name: layer.name,
      role: original?.shadowOnly ? 'shadow' : 'foreground',
      source: original && isIndependentRgba(original) ? 'prepared' : 'raw',
      rgba: expandToFullFrame(layer, input.width, input.height),
      bounds: { x: layer.x, y: layer.y, width: layer.width, height: layer.height },
      opacity: layer.opacity,
    };
  });
  const result = validateIndependentLayerGroup({
    width: input.width,
    height: input.height,
    source: input.source,
    background: document.layers[0]!.rgba,
    foregrounds,
  });
  if (result.status === 'pass' || input.independentValidation === 'audit') return;
  // An opaque source under a translucent upper layer cannot prove its dry RGB
  // by itself. Current, independently bound RGBA and an explicit complete local
  // review resolve that sole uncertainty; a legacy prepared flag does not.
  const reviewedIndependentGroup = hasCurrentIndependentGroupReview(input);
  const onlySourceColorReview = result.groups.every(group => group.activePixels > 0 && group.changedPixelsWhenHidden > 0
    && (group.exactOpaqueSourceRgb ? group.physicalIndependentRGBA && group.diagnostics.length === 0 && group.diagnosticCodes.length === 0
      : group.diagnostics.length === 1 && group.diagnosticCodes.length === 1 && group.diagnosticCodes[0] === 'opaque-source-under-partial'));
  const sourceMatches = result.composite.matchesSource;
  // Explicit replacement licenses only background-only source coordinates.
  // Keep every nonzero foreground alpha (including optical edges) under the
  // original one-channel source comparison. Do not manufacture a new source
  // reference from the proposed composite to make the comparison pass.
  const licensedBackgroundChange = input.backgroundMode === 'replace' && reviewedIndependentGroup
    && matchesSourceUnderForeground(input.source, document, foregrounds);
  const noOtherGroupFailure = sourceMatches ? result.diagnostics.length === 0 && result.diagnosticCodes.length === 0
    : result.diagnostics.length === 1 && result.diagnosticCodes.length === 1 && result.diagnosticCodes[0] === 'source-composite-mismatch';
  if (reviewedIndependentGroup && onlySourceColorReview && noOtherGroupFailure
    && (sourceMatches || licensedBackgroundChange)) return;
  const diagnostics = [...result.diagnostics, ...result.groups.flatMap(group => group.diagnostics)];
  const detail = diagnostics.find(Boolean) ?? '独立 RGBA 图层未通过合成验证';
  const replacementScope = input.backgroundMode === 'replace'
    ? '完整背景替换当前只允许未被前景 alpha 覆盖的背景像素变化；半透明区域仍需重合成匹配原图。' : '';
  throw new Error(`独立 RGBA 分层验证失败：${detail}。${replacementScope}已保留返图，请先本地精修后再合成 PSD。`);
}

interface SourceGroupReviewBinding {
  layers: readonly SourcePixelLayer[];
  groupConfirmationDigest?: string;
  needsReconfirm?: boolean;
}

function hasCurrentLayerReview(layer: SourcePixelLayer, digest: string): boolean {
  return layer.semanticReviewAccepted === true && layer.semanticReviewDigest === digest
    && layer.layeringConfirmationDigest === digest;
}

function hasCurrentIndependentGroupReview(input: SourceGroupReviewBinding): boolean {
  const digest = input.groupConfirmationDigest;
  return input.needsReconfirm !== true && typeof digest === 'string' && confirmationDigestPattern.test(digest)
    && input.layers.every(layer => hasCurrentLayerReview(layer, digest))
    && input.layers.slice(1).every(layer => layer.independentRgbaCandidate === true && isIndependentRgba(layer));
}

function validateBackgroundReplacementPermission(input: SourceGroupReviewBinding): void {
  const digest = input.groupConfirmationDigest;
  if (typeof digest !== 'string' || !confirmationDigestPattern.test(digest)) {
    throw new Error('完整补全背景需要当前整图分层的确认摘要，请重新检查图层');
  }
  if (!hasCurrentLayerReview(input.layers[0]!, digest)) {
    throw new Error('完整补全背景尚未完成当前背景素材的本地核验，请重新检查背景层');
  }
  if (!input.layers.slice(1).every(layer => layer.independentRgbaCandidate === true && isIndependentRgba(layer))) {
    throw new Error('完整补全背景需要已核验的独立 RGBA 前景；原图透明蒙版请先本地精修并重新导入检查');
  }
  if (!hasCurrentIndependentGroupReview(input)) {
    throw new Error('完整补全背景的图层审核或确认摘要已过期，请重新逐层检查');
  }
}

function matchesSourceUnderForeground(source: Uint8Array, document: LayeredPsdDocument, foregrounds: readonly IndependentLayer[]): boolean {
  const composite = composeLayeredRgba({ ...document, layers: document.layers.map(layer => ({ ...layer, visible: true })) });
  for (let pixel = 0; pixel < document.width * document.height; pixel += 1) {
    const offset = pixel * 4;
    if (!foregrounds.some(layer => layer.rgba[offset + 3]! > 0)) continue;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(composite[offset + channel]! - source[offset + channel]!) > 1) return false;
    }
  }
  return true;
}

function expandToFullFrame(layer: LayeredPsdLayer, width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < layer.height; y += 1) {
    const sourceOffset = y * layer.width * 4;
    const targetOffset = ((layer.y + y) * width + layer.x) * 4;
    rgba.set(layer.rgba.subarray(sourceOffset, sourceOffset + layer.width * 4), targetOffset);
  }
  return rgba;
}

function backgroundMismatchError(layer: SourcePixelLayer): Error {
  return new Error(`图层“${layer.name}”的透明蒙版与补全背景不匹配，无法确定独立颜色；请先本地精修图层“${layer.name}”为独立前景，或检查该层与补全背景返图后再合成。可导出待修整 PSD，已有返图已保留。`);
}

/** An editable handoff for a failed provider matte. It never claims the masks compose correctly. */
export async function buildDraftSourceLayerDocument(input: Parameters<typeof buildSourceLayerDocument>[0]): Promise<LayeredPsdDocument> {
  const output: LayeredPsdLayer[] = [];
  let bytes = 0;
  for await (const layer of iterateDraftSourceLayers(input)) {
    bytes += layer.rgba.length;
    if (bytes > 256 * 1024 * 1024) throw new Error('待修整 PSD 的图层像素总量超过 256 MiB');
    output.push(layer);
  }
  return { width: input.width, height: input.height, layers: output };
}

export async function encodeDraftSourceLayerPsd(input: Parameters<typeof buildSourceLayerDocument>[0],
  assertCurrent?: () => void): Promise<Uint8Array> {
  return encodeDraftPsd(input.width, input.height, iterateDraftSourceLayers(input), assertCurrent);
}

/** Each yielded buffer is owned by this iterator's consumer. A transferred
 * layer cannot detach the original pixels or a loader's cached result. */
export async function* iterateDraftSourceLayers(input: Parameters<typeof buildSourceLayerDocument>[0]): AsyncGenerator<LayeredPsdLayer> {
  const { width, height, source, layers, selection } = input;
  for (const layer of layers) if (layer.representationError) throw new Error(layer.representationError);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
    || source.length !== width * height * 4 || source.length > 128 * 1024 * 1024) throw new Error('原图尺寸超出当前分层处理范围');
  if (layers.length < 2 || layers[0]?.kind !== 'background' || layers.slice(1).some(layer => layer.kind !== 'transparent'))
    throw new Error('待修整 PSD 需要原图和至少一个前景返图');
  for (let i = 3; i < source.length; i += 4) if (source[i] !== 255) throw new Error('待修整 PSD 需要不透明原图');
  const existingIds = new Set(layers.map(layer => layer.id));
  let originalId = 'source-original';
  while (existingIds.has(originalId)) originalId += '-copy';
  yield { id: originalId, name: '原图对照（返图待修整）', kind: 'background',
    x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: source.slice() };
  {
    const background = await layers[0]!.load();
    if (background.length !== source.length) throw new Error('补全背景尺寸与原图不一致');
    yield { id: layers[0]!.id, name: `${layers[0]!.name}（补全背景候选）`, kind: 'alternate-background',
      x: 0, y: 0, width, height, visible: false, opacity: 1,
      rgba: applyLayerSelection(background.slice(), width, height, selection, source) };
  }
  for (const layer of layers.slice(1)) {
    if (!layer.bounds) throw new Error(`图层“${layer.name}”缺少原图位置`);
    const mask = await layer.load();
    if (mask.length !== source.length) throw new Error(`图层“${layer.name}”像素尺寸与原图不一致`);
    let rgba: Uint8Array;
    if (isIndependentRgba(layer)) rgba = mask.slice();
    else if (layer.maskSpace === 'source') {
      rgba = source.slice();
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i + 3] = Math.round(source[i + 3]! * mask[i + 3]! / 255);
        if (!rgba[i + 3]) rgba.fill(0, i, i + 4);
      }
    } else rgba = extractOriginalLayer(source, mask, width, height, layer.bounds, layer.maskSpace);
    rgba = applyLayerSelection(rgba, width, height, selection);
    const trimmed = trimTransparentLayer({ ...layer, id: layer.id, name: `${layer.name}（待修整）`, kind: 'transparent',
      x: 0, y: 0, width, height, visible: false, rgba });
    yield trimmed;
  }
}
