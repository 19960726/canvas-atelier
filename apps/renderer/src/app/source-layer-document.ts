import { extractOriginalLayer } from './source-layer-pixels';
import { applyLayerSelection, type LayeringBox, type LayeringSelection } from './layering-selection';
import { trimTransparentLayer, type LayeredPsdDocument, type LayeredPsdLayer } from './layered-psd';
import {repairLayerBackground,extractShadowResidual} from './layer-background-repair';

export interface SourcePixelLayer {
  id: string; name: string; kind: 'background' | 'transparent'; visible: boolean; opacity: number;
  bounds?: LayeringBox;
  maskSpace?: 'source' | 'bounds';
  preparedRgb?: boolean;
  shadowOnly?: boolean;
  load: () => Promise<Uint8Array>;
}

/** Decode masks one at a time, retain original placement and trim only transparent padding. */
export async function buildSourceLayerDocument(input: {
  width: number; height: number; source: Uint8Array; selection: LayeringSelection; layers: readonly SourcePixelLayer[];
  backgroundMode?: 'preserve' | 'replace';
}): Promise<LayeredPsdDocument> {
  const { width, height, source, layers, selection } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
    || source.length !== width * height * 4 || source.length > 128 * 1024 * 1024) throw new Error('原图尺寸超出当前分层处理范围');
  if (layers.length < 2 || layers[0]?.kind !== 'background' || layers.slice(1).some(layer => layer.kind !== 'transparent')) throw new Error('分层记录需要一个背景和至少一个前景');
  for (let i = 3; i < source.length; i += 4) if (source[i] !== 255) throw new Error('原图像素分层需要不透明原图，请先合成背景');
  if (layers.slice(1).some(layer => !layer.bounds)) throw new Error('请先标注每个图层在原图中的位置');
  if (input.backgroundMode === 'replace' && selection.mode !== 'whole') throw new Error('完整补全背景只适用于整图分层');
  const generated = await layers[0]!.load();
  if (generated.length !== source.length) throw new Error('背景补全尺寸与原图不一致');
  if (input.backgroundMode === 'replace') for (let p = 3; p < generated.length; p += 4) {
    if (generated[p] !== 255) throw new Error('完整补全背景包含透明空洞，请检查背景层');
  }
  const coverage = new Uint8Array(width * height);
  const edgeFallback = new Uint8Array(width * height);
  const foregrounds: LayeredPsdLayer[] = [];
  const objects=layers.slice(1).filter(layer=>!layer.shadowOnly);
  const providerMasks: { layer: SourcePixelLayer; pixels: number; index: number }[] = [];
  const providerIntersections: Uint32Array[] = [];
  let providerOwners: Uint32Array | undefined;
  // Provider source-space mattes must reconstruct original pixels when all
  // layers are visible. Use the donor only under actual foreground coverage;
  // applying donor feathering outside those mattes visibly changes the image.
  // Locally prepared RGB layers use the separate donor repair path.
  const allowEdgeFallback=objects.length>0&&objects.every(layer=>layer.preparedRgb || layer.maskSpace === 'source');
  const repair=objects.length>0&&objects.every(layer=>layer.preparedRgb);
  let totalBytes = source.length;
  // Legacy source-color masks must not duplicate the same source object into
  // lower layers. Prepared foreground RGBA is already separated and must keep
  // its own pixels so transparency and visibility remain independently editable.
  const processingOrder=[...objects].reverse().concat(layers.slice(1).filter(layer=>layer.shadowOnly).reverse());
  for (const layer of processingOrder) {
    if(repair&&layer.shadowOnly)continue;
    const mask = await layer.load();
    if (mask.length !== source.length) throw new Error('图层像素尺寸与原图不一致');
    let rgba: Uint8Array;
    try {
      rgba = applyLayerSelection(layer.preparedRgb ? mask.slice()
        : extractOriginalLayer(source, mask, width, height, layer.bounds!, layer.maskSpace), width, height, selection);
    } catch (error) {
      throw new Error(`图层“${layer.name}”：${error instanceof Error ? error.message : '原图像素提取失败'}`);
    }
    if (!rgba.some((value, index) => index % 4 === 3 && value > 0)) throw new Error(`图层“${layer.name}”在所选范围内没有可见像素，请校正原图位置`);
    if (!layer.preparedRgb && !layer.shadowOnly && layer.maskSpace === 'source') {
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
      if (coverage[i] && (!layer.preparedRgb||layer.shadowOnly)) rgba.fill(0, offset, offset + 4);
      else {
        coverage[i] = 1;
        if (generated[offset + 3] !== 255) throw new Error('补全背景包含透明空洞，请重新检查背景层');
        if (!layer.preparedRgb && layer.maskSpace === 'source' && rgba[offset + 3]! < 255) {
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
            if (!allowEdgeFallback) throw new Error(`图层“${layer.name}”的透明蒙版与补全背景不匹配，无法保留原图颜色；请检查该层与背景返图`);
            edgeFallback[offset / 4] = 1;
          } else {
            for (let channel = 0; channel < 3; channel++) rgba[offset + channel] = corrected[channel]!;
          }
        }
      }
    }
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
  let background:Uint8Array = source.slice();
  for (let i = 0; i < coverage.length; i++) {
    if (!coverage[i]) continue;
    const offset = i * 4;
    if (generated[offset + 3] !== 255) throw new Error('补全背景包含透明空洞，请重新检查背景层');
    background.set(generated.subarray(offset, offset + 4), offset);
  }
  if (!repair) {
    // A valid aligned source matte can still carry provider RGB that was
    // composited over a different backdrop. Keep the original backdrop at
    // those edge pixels without enabling the broader donor repair pass.
    for (let i = 0, p = 0; i < edgeFallback.length; i += 1, p += 4) {
      if (edgeFallback[i]) background.set(source.subarray(p, p + 4), p);
    }
  }
  if(repair){
    const erased=coverage.slice(),excluded=coverage.slice();
    for(const layer of layers.slice(1).filter(layer=>layer.shadowOnly)){
      const b=layer.bounds!;
      for(let y=Math.floor(b.y*height);y<Math.min(height,Math.ceil((b.y+b.height)*height));y++)for(let x=Math.floor(b.x*width);x<Math.min(width,Math.ceil((b.x+b.width)*width));x++)erased[y*width+x]=1;
    }
    for(let p=0;p<erased.length;p++)if(erased[p]&&generated[p*4+3]!==255)throw new Error('补全背景包含透明空洞，请重新检查背景层');
    background=input.backgroundMode === 'replace' ? generated.slice() : repairLayerBackground(source,generated,width,height,erased);
    // Donor feathering is useful beneath a removed object, but its correction
    // field must not repaint nearby pixels that no foreground actually covers.
    if (input.backgroundMode !== 'replace') for (let pixel = 0; pixel < erased.length; pixel++) {
      if (!erased[pixel]) background.set(source.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
    }
    // At anti-aliased edges the foreground is original RGB with partial alpha.
    // Keep the original backdrop at those pixels so source + matte reconstructs
    // the original without baking the generated background into the edge.
    if (input.backgroundMode !== 'replace') for (let i = 0, p = 0; i < edgeFallback.length; i += 1, p += 4) {
      if (edgeFallback[i]) background.set(source.subarray(p, p + 4), p);
    }
    background=applyLayerSelection(background,width,height,selection,source);
    for(const layer of layers.slice(1).filter(layer=>layer.shadowOnly).reverse()){
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
  return { width, height, layers: [{ ...layers[0]!, x: 0, y: 0, width, height, rgba: background }, ...foregrounds] };
}

/** An editable handoff for a failed provider matte. It never claims the masks compose correctly. */
export async function buildDraftSourceLayerDocument(input: Parameters<typeof buildSourceLayerDocument>[0]): Promise<LayeredPsdDocument> {
  const { width, height, source, layers, selection } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192
    || source.length !== width * height * 4 || source.length > 128 * 1024 * 1024) throw new Error('原图尺寸超出当前分层处理范围');
  if (layers.length < 2 || layers[0]?.kind !== 'background' || layers.slice(1).some(layer => layer.kind !== 'transparent'))
    throw new Error('待修整 PSD 需要原图和至少一个前景返图');
  for (let i = 3; i < source.length; i += 4) if (source[i] !== 255) throw new Error('待修整 PSD 需要不透明原图');
  const existingIds = new Set(layers.map(layer => layer.id));
  let originalId = 'source-original';
  while (existingIds.has(originalId)) originalId += '-copy';
  const background = await layers[0]!.load();
  if (background.length !== source.length) throw new Error('补全背景尺寸与原图不一致');
  const output: LayeredPsdLayer[] = [
    { id: originalId, name: '原图对照（返图待修整）', kind: 'background',
      x: 0, y: 0, width, height, visible: true, opacity: 1, rgba: source.slice() },
    { id: layers[0]!.id, name: `${layers[0]!.name}（补全背景候选）`, kind: 'alternate-background',
      x: 0, y: 0, width, height, visible: false, opacity: 1,
      rgba: applyLayerSelection(background.slice(), width, height, selection, source) },
  ];
  let bytes = source.length + background.length;
  if (bytes > 256 * 1024 * 1024) throw new Error('待修整 PSD 的图层像素总量超过 256 MiB');
  for (const layer of layers.slice(1)) {
    if (!layer.bounds) throw new Error(`图层“${layer.name}”缺少原图位置`);
    const mask = await layer.load();
    if (mask.length !== source.length) throw new Error(`图层“${layer.name}”像素尺寸与原图不一致`);
    let rgba: Uint8Array;
    if (layer.preparedRgb) rgba = mask.slice();
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
    bytes += trimmed.rgba.length;
    if (bytes > 256 * 1024 * 1024) throw new Error('待修整 PSD 的图层像素总量超过 256 MiB');
    output.push(trimmed);
  }
  return { width, height, layers: output };
}
