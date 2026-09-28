import { useEffect, useState } from 'react';
import { buildDraftSourceLayerDocument, buildSourceLayerDocument } from '../app/source-layer-document';
import { decodeLayerPixels, layerPixelsUrl } from '../app/managed-layer-pixels';
import { boxSchema, readLayeringSelection } from '../app/layering-selection';
import type { LayeredImageConfig } from '../app/layered-image-config';
import type { CanvasModuleNode } from '@agent-canvas/domain';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import {isShadowOnlyLayer} from '../app/shadow-layer-role';

export interface SourceLayerInput {
  sourceUrl: string; width: number; height: number; selection: unknown; backgroundMode?: 'preserve' | 'replace';
  layers: { record: LayeredImageConfig['layers'][number]['record']; url: string; bounds: unknown; maskSpace?: 'source' | 'bounds'; preparedRgb?: boolean; shadowOnly?:boolean }[];
}

export function orderedLayerPlan(config: Readonly<Record<string, unknown>>, nodes: readonly CanvasModuleNode[]): Record<string, unknown>[] {
  const plans=(Array.isArray(config.planLayers)?config.planLayers:[]).filter((value):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value));
  const byId=new Map(nodes.map(node=>[node.data.config.layerId,node]));
  const savedOrder=new Map((Array.isArray(config.layers)?config.layers:[]).map((layer,index)=>[layer.layerId,index]));
  return [...plans].sort((a,b)=>{
    if(a.kind==='background')return b.kind==='background'?0:-1;
    if(b.kind==='background')return 1;
    return Number(byId.get(a.layerId)?.data.config.order??savedOrder.get(a.layerId)??plans.indexOf(a))
      -Number(byId.get(b.layerId)?.data.config.order??savedOrder.get(b.layerId)??plans.indexOf(b));
  });
}

export function sourceLayerInputFromNodes(config: Readonly<Record<string, unknown>>, nodes: readonly CanvasModuleNode[], assets: readonly ProjectImageAssetSummary[]): SourceLayerInput | null {
  if (config.pixelMode !== 'source' || !Array.isArray(config.planLayers)) return null;
  const source = assets.find(asset => asset.assetId === config.sourceAssetId);
  if (!source) return null;
  const width = source.width ?? Number(config.canvasWidth), height = source.height ?? Number(config.canvasHeight);
  const layers: SourceLayerInput['layers'] = [];
  for (const plan of orderedLayerPlan(config,nodes)) {
    const node = nodes.find(candidate => candidate.data.config.layerId === plan.layerId);
    const asset = assets.find(asset => asset.assetId === node?.data.config.resultAssetId);
    if (!node || !asset || node.data.config.qualityStatus !== 'passed') return null;
    layers.push({ record: { layerId: String(plan.layerId), kind: plan.kind === 'background' ? 'background' : 'transparent', name: String(plan.name),
      assetId: asset.assetId, x: 0, y: 0, width, height, visible: node.data.config.visible !== false, opacity: Number(node.data.config.opacity ?? 1) },
      url: asset.displayUrl, bounds: node.data.config.sourceBounds, preparedRgb: node.data.config.pixelColorSpace === 'foreground',shadowOnly:isShadowOnlyLayer(node.data.config),
      maskSpace: node.data.config.maskSpace === 'source' ? 'source' : 'bounds' });
  }
  return { sourceUrl: source.displayUrl, width, height, selection: config.layerSelection,
    backgroundMode: config.backgroundMode === 'replace' ? 'replace' : 'preserve', layers };
}

export async function prepareSourceLayerDocument(input: SourceLayerInput) {
  return buildSourceLayerDocument({ width: input.width, height: input.height,
    source: await decodeLayerPixels(input.sourceUrl, input.width, input.height), selection: readLayeringSelection(input.selection),
    backgroundMode: input.backgroundMode,
    layers: input.layers.map(({ record, url, bounds, maskSpace, preparedRgb,shadowOnly }) => ({ id: record.layerId, name: record.name, kind: record.kind, maskSpace, preparedRgb,shadowOnly,
      visible: record.visible, opacity: record.opacity,
      ...(record.kind === 'transparent' ? { bounds: boxSchema.parse(bounds) } : {}),
      load: () => decodeLayerPixels(url, input.width, input.height) })),
  });
}

export async function prepareDraftSourceLayerDocument(input: SourceLayerInput) {
  return buildDraftSourceLayerDocument({ width: input.width, height: input.height,
    source: await decodeLayerPixels(input.sourceUrl, input.width, input.height), selection: readLayeringSelection(input.selection),
    layers: input.layers.map(({ record, url, bounds, maskSpace, preparedRgb, shadowOnly }) => ({
      id: record.layerId, name: record.name, kind: record.kind, maskSpace, preparedRgb, shadowOnly,
      visible: record.visible, opacity: record.opacity,
      ...(record.kind === 'transparent' ? { bounds: boxSchema.parse(bounds) } : {}),
      load: () => decodeLayerPixels(url, input.width, input.height),
    })),
  });
}

// Serial processing bounds the peak memory when several groups mount together.
let previewQueue: Promise<unknown> = Promise.resolve();
export function enqueueLayerPreview<T>(work: () => Promise<T>): Promise<T> {
  const result = previewQueue.then(work);
  previewQueue = result.catch(() => {});
  return result;
}
const activePreviews = new Map<string, { users: number; promise: Promise<LayeredImageConfig | null> }>();
export function useSourceLayerPreview(input: SourceLayerInput | null) {
  const key = JSON.stringify(input);
  const [state, setState] = useState<{ key: string; preview: LayeredImageConfig | null; error: string | null }>({ key: '', preview: null, error: null });
  useEffect(() => {
    if (!input) return;
    let cancelled = false;
    let entry = activePreviews.get(key);
    if (!entry) {
      const created = { users: 0, promise: Promise.resolve<LayeredImageConfig | null>(null) };
      created.promise = enqueueLayerPreview(async () => {
        if (!created.users) return null;
        const doc = await prepareSourceLayerDocument(input);
        if (!created.users) return null;
        return { canvasWidth: doc.width, canvasHeight: doc.height,
          layers: doc.layers.map((layer, index) => ({ record: { ...input.layers[index]!.record, x: layer.x, y: layer.y, width: layer.width, height: layer.height },
            asset: { assetId: input.layers[index]!.record.assetId, mediaType: 'image/png', displayUrl: layerPixelsUrl(layer.rgba, layer.width, layer.height) } })) };
      });
      activePreviews.set(key, created); entry = created;
    }
    const shared = entry;
    shared.users++;
    void shared.promise.then(preview => {
      if (!cancelled) setState({ key, preview, error: null });
    }).catch(error => { if (!cancelled) setState({ key, preview: null, error: error instanceof Error ? error.message : '原图像素处理失败' }); });
    return () => { cancelled = true; if (--shared.users === 0 && activePreviews.get(key) === shared) activePreviews.delete(key); };
  }, [key]);
  return state.key === key ? state : { key, preview: null, error: null };
}
