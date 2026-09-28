import { useMemo, useState } from 'react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import type { CanvasModuleNode, ModelJob } from '@agent-canvas/domain';
import { encodeLayeredPsd, trimTransparentLayer, type LayeredPsdDocument } from '../app/layered-psd';
import { parseLayeredImageConfig, type LayeredImageRecord } from '../app/layered-image-config';
import { applyLayerSelection, compatibleLayerDimensions, layerSelectionClip, readLayeringSelection } from '../app/layering-selection';
import { LayerScopePreview } from './LayerScopePreview';
import { orderedLayerPlan, prepareSourceLayerDocument, useSourceLayerPreview, type SourceLayerInput } from './source-layer-preview';
import { SourceLayerAlignment } from './SourceLayerAlignment';
import { SourceLayerRefinement } from './SourceLayerRefinement';
import type { MattingRegion } from '@agent-canvas/desktop-core/preload-api';
import { boxSchema } from '../app/layering-selection';
import type { LayeringBox } from '../app/layering-selection';
import { decodeImageWithTimeout } from '../app/decode-image-timeout';
import {isShadowOnlyLayer} from '../app/shadow-layer-role';

type ManagedImage = Pick<ProjectImageAssetSummary, 'assetId' | 'mediaType' | 'displayUrl'> & Partial<Pick<ProjectImageAssetSummary, 'width' | 'height'>>;

export function ImageLayeringWorkbench({ config, assets, layerNodes = [], jobs = [], onLayersChange, onBackgroundModeChange, onRefreshJobs, onRetryJob, canRetryJob, onApplySourceBounds, onRecheckLayer, onRefineLayer }: {
  config: Readonly<Record<string, unknown>>;
  assets: readonly ManagedImage[];
  layerNodes?: readonly CanvasModuleNode[];
  jobs?: readonly ModelJob[];
  onLayersChange: (layers: LayeredImageRecord[]) => void | Promise<void>;
  onBackgroundModeChange?: (mode: 'preserve' | 'replace') => Promise<void>;
  onRefreshJobs?: () => Promise<void>;
  onRetryJob?: (jobId: string) => Promise<void>;
  canRetryJob?: (job: ModelJob) => boolean;
  onApplySourceBounds?: (bounds: Record<string, LayeringBox>) => Promise<void>;
  onRecheckLayer?: (nodeId: string, assetId: string) => Promise<void>;
  onRefineLayer?: (nodeId: string, regions: MattingRegion[]) => Promise<void>;
}) {
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'original' | 'composite'>('composite');
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [switchingBackground, setSwitchingBackground] = useState(false);
  const [retryCandidateId, setRetryCandidateId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const generatedConfig = useMemo(() => {
    if (!Array.isArray(config.planLayers)) return config;
    const nodesByLayer = new Map(layerNodes.map((node) => [node.data.config.layerId, node]));
    const orderedPlan = orderedLayerPlan(config,layerNodes);
    const records = orderedPlan.map((layer, index) => {
      const node = nodesByLayer.get(layer.layerId);
      if (!node || typeof node.data.config.resultAssetId !== 'string' || node.data.config.qualityStatus !== 'passed') return null;
      const width = config.canvasWidth;
      const height = config.canvasHeight;
      if (typeof width !== 'number' || typeof height !== 'number') return null;
      return {
        layerId: String(layer.layerId), kind: index === 0 ? 'background' : 'transparent', name: typeof node.data.config.name === 'string' ? node.data.config.name : String(layer.name ?? '图层'),
        assetId: node.data.config.resultAssetId, x: 0, y: 0, width, height, visible: node.data.config.visible !== false,
        opacity: typeof node.data.config.opacity === 'number' ? node.data.config.opacity : 1,
      };
    });
    return records.some((record) => record === null) ? { ...config, layers: [] } : { ...config, layers: records };
  }, [assets, config, layerNodes]);
  const parsed = useMemo(() => {
    try { return { document: parseLayeredImageConfig(generatedConfig, assets), error: null }; }
    catch (error) { return { document: null, error: error instanceof Error ? error.message : '分层记录无法读取' }; }
  }, [assets, generatedConfig]);
  const generatedPlan = Array.isArray(config.planLayers) ? config.planLayers.filter((layer): layer is Record<string, unknown> => typeof layer === 'object' && layer !== null && !Array.isArray(layer)) : [];
  const layerStatusById = new Map(layerNodes.map((node) => [node.data.config.layerId, node.data.config]));
  const sourceAsset = assets.find((asset) => asset.assetId === config.sourceAssetId);
  const selectionResult = useMemo(() => {
    try { return { selection: readLayeringSelection(config.layerSelection), error: null }; }
    catch { return { selection: null, error: '保存的分层范围无效，请重新选择范围。' }; }
  }, [config.layerSelection]);
  const selection = selectionResult.selection;
  const selectionClip = selection ? layerSelectionClip(selection) : undefined;
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const passedCount = generatedPlan.filter((layer) => layerStatusById.get(layer.layerId)?.qualityStatus === 'passed').length;
  const failedCount = generatedPlan.filter((layer) => {
    const layerConfig = layerStatusById.get(layer.layerId);
    const job = typeof layerConfig?.jobId === 'string' ? jobsById.get(layerConfig.jobId) : undefined;
    return !layerConfig || layerConfig.qualityStatus === 'failed' || job?.status === 'failed' || job?.status === 'cancelled';
  }).length;
  const sourceInput: SourceLayerInput | null = config.pixelMode === 'source' && parsed.document && sourceAsset && selection ? {
    sourceUrl: sourceAsset.displayUrl, width: sourceAsset.width ?? parsed.document.canvasWidth, height: sourceAsset.height ?? parsed.document.canvasHeight,
    selection, backgroundMode: config.backgroundMode === 'replace' ? 'replace' : 'preserve', layers: parsed.document.layers.map(layer => {
      const layerConfig = layerNodes.find(node => node.data.config.layerId === layer.record.layerId)?.data.config;
      return { record: layer.record, url: layer.asset.displayUrl, bounds: layerConfig?.sourceBounds,
        preparedRgb: layerConfig?.pixelColorSpace === 'foreground',shadowOnly:isShadowOnlyLayer(layerConfig??{}),
        maskSpace: layerConfig?.maskSpace === 'source' ? 'source' as const : 'bounds' as const };
    }),
  } : null;
  const sourcePreview = useSourceLayerPreview(sourceInput);
  const layered = config.pixelMode === 'source' ? sourcePreview.preview : parsed.document;
  const contentOverlap = typeof sourcePreview.error === 'string' && sourcePreview.error.includes('内容重叠');
  const overallStatus = contentOverlap ? '内容重叠 · 需精修' : config.pixelMode === 'source' && sourcePreview.error ? '图层处理失败'
    : failedCount > 0 ? '需复核'
      : generatedPlan.length > 0 && passedCount === generatedPlan.length
        ? layered ? '图层已返回 · 待检查边缘与背景' : '正在处理图层'
        : generatedPlan.length > 0 ? '进行中' : '等待任务';
  const selected = layered?.layers.find(layer => layer.record.layerId === selectedLayerId);
  const retryCandidate = jobsById.get(retryCandidateId ?? '');
  const retryLayerName = retryCandidate?.layeringLayerId === undefined ? '图层'
    : String(generatedPlan.find((layer) => layer.layerId === retryCandidate.layeringLayerId)?.name ?? '图层');

  const refreshJobs = async () => {
    if (!onRefreshJobs || refreshing) return;
    setRefreshing(true);
    setExportError(null);
    try { await onRefreshJobs(); }
    catch (error) { setExportError(error instanceof Error ? error.message : '任务状态读取失败'); }
    finally { setRefreshing(false); }
  };

  const confirmRetry = async () => {
    if (!retryCandidate || !onRetryJob || retrying) return;
    setRetrying(true);
    setExportError(null);
    try { await onRetryJob(retryCandidate.id); setRetryCandidateId(null); }
    catch (error) { setExportError(error instanceof Error ? error.message : '图层任务重试失败'); }
    finally { setRetrying(false); }
  };

  const changeLayers = (next: LayeredImageRecord[]) => {
    setExportError(null);
    try {
      // Preview records may be trimmed; durable records keep the provider asset geometry.
      const records = next.map(record => ({ ...(parsed.document?.layers.find(layer => layer.record.layerId === record.layerId)?.record ?? record), visible: record.visible, opacity: record.opacity }));
      void Promise.resolve(onLayersChange(records)).catch(error => {
        setExportError(error instanceof Error ? error.message : '图层保存失败');
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '图层保存失败');
    }
  };
  const changeBackgroundMode = async (mode: 'preserve' | 'replace') => {
    if (!onBackgroundModeChange || switchingBackground) return;
    setSwitchingBackground(true);
    setExportError(null);
    try { await onBackgroundModeChange(mode); }
    catch (error) { setExportError(error instanceof Error ? error.message : '背景模式保存失败'); }
    finally { setSwitchingBackground(false); }
  };
  const moveLayer = (index: number, direction: -1 | 1) => {
    if (!layered || index === 0 || index + direction < 1 || index + direction >= layered.layers.length) return;
    const next = layered.layers.map(layer => layer.record);
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    changeLayers(next);
  };
  const buildPsdBytes = async (): Promise<Uint8Array> => {
    if (!layered) throw new Error('尚无可导出的分层结果');
    if (!selection) throw new Error(selectionResult.error!);
    if (config.pixelMode === 'source') {
      if (!sourceInput) throw new Error('原图或图层位置记录不完整');
      return encodeLayeredPsd(await prepareSourceLayerDocument(sourceInput));
    }
    // Generated layers use source coordinates in durable records; export at the returned pixel resolution.
    let exportWidth = layered.canvasWidth, exportHeight = layered.canvasHeight;
    if (generatedPlan.length > 0) {
      for (const { record, asset } of layered.layers) {
        const node = layerNodes.find(candidate => candidate.data.config.resultAssetId === record.assetId);
        const metadata = assets.find(candidate => candidate.assetId === asset.assetId);
        const width = metadata?.width ?? node?.data.config.resultWidth;
        const height = metadata?.height ?? node?.data.config.resultHeight;
        if (typeof width === 'number' && typeof height === 'number' && width * height > exportWidth * exportHeight
          && compatibleLayerDimensions(width, height, layered.canvasWidth, layered.canvasHeight)) {
          exportWidth = width; exportHeight = height;
        }
      }
    }
    const scoped = selection.mode !== 'whole';
    if (scoped && !sourceAsset) throw new Error('无法读取分层原图，不能保留选框外的像素。');
    const sourcePixels = scoped ? await decodeManagedLayer(sourceAsset!, { name: '原图', width: exportWidth, height: exportHeight }) : undefined;
    const outputLayers: LayeredPsdDocument['layers'][number][] = [];
    for (const { record, asset } of layered.layers) {
      const scaled = { ...record,
        x: Math.round(record.x * exportWidth / layered.canvasWidth), y: Math.round(record.y * exportHeight / layered.canvasHeight),
        width: Math.round(record.width * exportWidth / layered.canvasWidth), height: Math.round(record.height * exportHeight / layered.canvasHeight) };
      if (scoped && (scaled.x !== 0 || scaled.y !== 0 || scaled.width !== exportWidth || scaled.height !== exportHeight)) throw new Error('选区图层需要保留完整画布位置。');
      const rgba = await decodeManagedLayer(asset, scaled);
      outputLayers.push(trimTransparentLayer({ ...scaled, id: record.layerId,
        rgba: applyLayerSelection(rgba, scaled.width, scaled.height, selection, record.kind === 'background' ? sourcePixels : undefined) }));
    }
    const decoded: LayeredPsdDocument = {
        width: exportWidth,
        height: exportHeight,
        layers: outputLayers,
    };
    return encodeLayeredPsd(decoded);
  };
  const exportPsd = async () => {
    if (!layered || exporting) return;
    setExportError(null);
    setExporting(true);
    try {
      const bytes = await buildPsdBytes();
      const owned = new Uint8Array(bytes.byteLength);
      owned.set(bytes);
      const url = URL.createObjectURL(new Blob([owned.buffer], { type: 'image/vnd.adobe.photoshop' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'canvas-atelier-layers.psd';
      link.click();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'PSD 导出失败');
    } finally {
      setExporting(false);
    }
  };
  const openPsdInPhotoshop = async () => {
    if (!layered || exporting) return;
    setExportError(null);
    setExporting(true);
    try {
      const open = window.novusDesktop?.projectImages?.openLayeredPsdInPhotoshop;
      if (!open) throw new Error('当前环境不支持在 Photoshop 中打开 PSD');
      const result = await open(await buildPsdBytes());
      if (!result.ok && result.code !== 'cancelled') {
        const messages = {
          invalid_psd: 'PSD 文件无效，请重新导出',
          photoshop_not_installed: '未找到 Photoshop CS6 或更高版本，请改用“导出 PSD”',
          discovery_failed: '查找 Photoshop 时出错，请改用“导出 PSD”',
          dialog_failed: '无法打开 PSD 保存对话框，请重试',
          save_failed: 'PSD 保存失败，请检查目标目录',
          open_failed: 'PSD 已保存，但 Photoshop 启动失败；请手动打开',
        } as const;
        throw new Error(result.code ? messages[result.code as keyof typeof messages] ?? 'PSD 打开失败' : 'PSD 打开失败');
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Photoshop 打开失败');
    } finally {
      setExporting(false);
    }
  };

  return <section className="image-layering nodrag nowheel" aria-label="图片自动分层工作台">
    <header><strong>图片自动分层</strong><span>透明图层与多图层 PSD</span></header>
    {parsed.error && <p role="alert">分层结果无效：{parsed.error}</p>}
    {selectionResult.error && <p role="alert">{selectionResult.error}</p>}
    {sourcePreview.error && config.pixelMode === 'source' && <div className="image-layering__issue" role="alert"><strong>{contentOverlap ? '图层内容重叠，暂不能合成或导出 PSD' : '图片已返回，合成暂不可用'}</strong><p>{contentOverlap ? sourcePreview.error : '请检查问题图层的透明区域与背景；已有返图已保留。'}</p>{!contentOverlap && <details><summary>查看失败原因</summary><p>{sourcePreview.error}</p></details>}</div>}
    {config.pixelMode === 'source' && sourceInput && !sourcePreview.preview && !sourcePreview.error && <p role="status">正在提取原图像素…</p>}
    <div className="image-layering__repair-tools" role="group" aria-label="图层修整">
    {sourceAsset?.width && sourceAsset.height && onRefineLayer && <SourceLayerRefinement
      key={`${String(config.groupId)}:${sourceAsset.assetId}`} sourceUrl={sourceAsset.displayUrl} width={sourceAsset.width} height={sourceAsset.height}
      layers={layerNodes.filter(node => node.data.config.layerKind !== 'background' && !isShadowOnlyLayer(node.data.config) && boxSchema.safeParse(node.data.config.sourceBounds).success).map(node => ({
        nodeId: node.id, name: String(node.data.config.name ?? '图层'),
        resultAssetId: typeof node.data.config.resultAssetId === 'string' ? node.data.config.resultAssetId : undefined,
        regions: (Array.isArray(node.data.config.mattingRegions) ? node.data.config.mattingRegions : []).filter((region): region is MattingRegion =>
          region !== null && typeof region === 'object' && ['keep','clear','glass'].includes(region.mode) && boxSchema.safeParse(region.box).success),
      }))} onApply={onRefineLayer} />}
    {sourceAsset && generatedPlan.length > 1 && onApplySourceBounds && <SourceLayerAlignment
      sourceUrl={sourceAsset.displayUrl} width={sourceAsset.width ?? Number(config.canvasWidth)} height={sourceAsset.height ?? Number(config.canvasHeight)}
      layers={generatedPlan.filter(layer => layer.kind !== 'background').map(layer => ({ layerId: String(layer.layerId), name: String(layer.name), bounds: layerStatusById.get(layer.layerId)?.sourceBounds }))}
      onApply={onApplySourceBounds} />}
    </div>
    {generatedPlan.length > 0 && <details className="image-layering__analysis-details"><summary>查看分层分析详情</summary>
      <ol aria-label="已保存的分层分析">{generatedPlan.map(layer => <li key={String(layer.layerId)}><strong>{String(layer.name ?? '图层')}</strong><p>{String(layer.description ?? '')}</p></li>)}</ol>
    </details>}
    {generatedPlan.length > 0 && <div className="image-layering__progress-heading" role="status" title="格式检查只确认图片可读取、画幅与透明通道，不代表合成和边缘质量通过。"><strong>格式检查 {passedCount} / {generatedPlan.length} 层</strong><span data-state={sourcePreview.error ? 'error' : 'pending'}>{overallStatus}</span></div>}
    {sourceAsset && <div className="image-layering__view-controls" role="group" aria-label="分层预览模式">
      <button type="button" aria-pressed={previewMode === 'original' || layered === null} onClick={() => setPreviewMode('original')}>原图</button>
      <button type="button" aria-pressed={previewMode === 'composite' && layered !== null} disabled={layered === null} onClick={() => setPreviewMode('composite')}>合成图</button>
    </div>}
    {config.pixelMode === 'source' && selection?.mode === 'whole' && onBackgroundModeChange && <div className="image-layering__background-choice">
      <div className="image-layering__view-controls" role="group" aria-label="背景合成方式">
        <button type="button" aria-pressed={config.backgroundMode !== 'replace'} disabled={switchingBackground || exporting}
          onClick={() => { void changeBackgroundMode('preserve'); }}>保留原图背景</button>
        <button type="button" aria-pressed={config.backgroundMode === 'replace'} disabled={switchingBackground || exporting}
          onClick={() => { void changeBackgroundMode('replace'); }}>使用完整补全背景</button>
      </div>
      <p>{config.backgroundMode === 'replace' ? '整张使用补全背景；厨房场景可能与原图不同。前景保持原图坐标和尺寸。'
        : '保留未被前景覆盖的原图背景；蒙版漏抠处可能留下残影。'}</p>
    </div>}
    {layered === null ? <div className="image-layering__empty">
      {sourceAsset && <img className="image-layering__source-preview" src={sourceAsset.displayUrl} alt="原图预览" draggable={false} />}
      <span>{generatedPlan.length > 0 ? '每层返回后立即显示在对应图片节点。全部图层可用后即可合成和导出 PSD。' : '连接一张图片，或从图片工具栏使用 AI 分层。'}</span>
      {generatedPlan.length > 0 && <ol className="image-layering__progress-list" aria-label="分层任务进度">{generatedPlan.map((layer) => {
        const layerConfig = layerStatusById.get(layer.layerId);
        const job = typeof layerConfig?.jobId === 'string' ? jobsById.get(layerConfig.jobId) : undefined;
        const status = !layerConfig ? '图层节点已删除'
          : layerConfig.qualityStatus === 'failed' ? '像素验证失败'
          : layerConfig?.qualityStatus === 'passed' ? '图片格式通过'
            : job?.status === 'failed' ? '任务失败'
              : job?.status === 'cancelled' ? '已取消'
                : job?.status === 'running' || job?.status === 'submitting' || layerConfig?.status === 'running' ? '生成中'
                  : job?.status === 'completed' || layerConfig?.status === 'validating' ? '图片已返回，正在检查'
                    : job?.status === 'queued' || layerConfig?.status === 'queued' ? '排队中' : '等待任务';
        return <li key={String(layer.layerId)}><span>{String(layer.name ?? '图层')}</span><b>{status}</b>
          {assets.find(asset => asset.assetId === layerConfig?.resultAssetId) && <img className="image-layering__returned-thumbnail"
            src={assets.find(asset => asset.assetId === layerConfig?.resultAssetId)!.displayUrl} alt={`已返回图层 ${String(layer.name ?? '图层')}`} />}
          {layerConfig?.qualityStatus === 'failed' && typeof layerConfig.resultAssetId === 'string' && onRecheckLayer && <button type="button"
            onClick={() => { const node = layerNodes.find(candidate => candidate.data.config.layerId === layer.layerId); if (node) void onRecheckLayer(node.id, String(layerConfig.resultAssetId)).catch(error => setExportError(error instanceof Error ? error.message : '本地检查失败')); }}>重新检查本地图片</button>}
          {(job?.status === 'failed' || job?.status === 'cancelled' || (job?.status === 'completed' && layerConfig?.qualityStatus === 'failed')) && onRetryJob && <button type="button"
            aria-label={`重试图层 ${String(layer.name ?? '图层')}`} disabled={!canRetryJob?.(job)}
            title={canRetryJob?.(job) ? '重新提交此图层任务' : '所选透明背景路由尚无验证证据，暂不能重试'}
            onClick={() => setRetryCandidateId(job.id)}>重试</button>}
        </li>;
      })}</ol>}
      {retryCandidate && <div className="image-layering__retry-confirm" role="group" aria-label="确认图层重试">
        <p>重新生成“{retryLayerName}”会再次提交 1 个图像任务，可能产生费用。</p>
        <div><button type="button" disabled={retrying} onClick={() => setRetryCandidateId(null)}>取消</button>
          <button type="button" disabled={retrying || !canRetryJob?.(retryCandidate)} onClick={() => { void confirmRetry(); }}>
            {retrying ? '正在重试…' : `确认重新生成 ${retryLayerName}`}
          </button></div>
      </div>}
      {generatedPlan.length === 0 && <p>AI 分层仅使用已通过验证的 GPT Image 透明背景路由；未验证时不会提交生成任务。</p>}
    </div> : <>
      <div className="image-layering__preview" role="img" aria-label={previewMode === 'original' && sourceAsset ? '原图预览区域' : '合成预览'} style={{ aspectRatio: `${layered.canvasWidth} / ${layered.canvasHeight}` }}>
        {previewMode === 'original' && sourceAsset ? <img src={sourceAsset.displayUrl} alt="原图预览" draggable={false} style={{ inset: 0, width: '100%', height: '100%' }} />
          : <>{config.pixelMode !== 'source' && selectionClip && sourceAsset && layered.layers[0]?.record.visible && <img src={sourceAsset.displayUrl} alt="选区外保留的原图" style={{ inset: 0, width: '100%', height: '100%' }} />}
          {layered.layers.filter(layer => layer.record.visible).map(({ record, asset }) => <img
          key={record.layerId}
          src={asset.displayUrl}
          alt={`合成预览图层 ${record.name}`}
          draggable={false}
          style={{ left: `${record.x / layered.canvasWidth * 100}%`, top: `${record.y / layered.canvasHeight * 100}%`,
            width: `${record.width / layered.canvasWidth * 100}%`, height: `${record.height / layered.canvasHeight * 100}%`, opacity: record.opacity, clipPath: config.pixelMode === 'source' ? undefined : selectionClip }}
        />)}</>}
      </div>
      <ol className="image-layering__list" aria-label="分层图层">
        {layered.layers.map(({ record, asset }, index) => <li key={record.layerId}>
          <button type="button" className="image-layering__thumbnail" aria-label={`预览图层 ${record.name}`} onClick={() => setSelectedLayerId(record.layerId)}>
            {selection && <LayerScopePreview url={asset.displayUrl} sourceUrl={sourceAsset?.displayUrl} selection={config.pixelMode === 'source' ? { mode: 'whole' } : selection} background={record.kind === 'background'} width={record.width} height={record.height} label="" />}
          </button>
          <span className="image-layering__name">{index + 1}. {record.name}</span>
          <button type="button" aria-label={`${record.visible ? '隐藏' : '显示'}图层 ${record.name}`} onClick={() => changeLayers(layered.layers.map((layer, layerIndex) => layerIndex === index
            ? { ...layer.record, visible: !layer.record.visible } : layer.record))}>{record.visible ? '可见' : '隐藏'}</button>
          <button type="button" aria-label={`下移图层 ${record.name}`} disabled={index <= 1} onClick={() => moveLayer(index, -1)}>↓</button>
          <button type="button" aria-label={`上移图层 ${record.name}`} disabled={index === 0 || index === layered.layers.length - 1} onClick={() => moveLayer(index, 1)}>↑</button>
        </li>)}
      </ol>
      {selected && <div className="image-layering__single" aria-label={`透明层预览 ${selected.record.name}`}>
        {selection && <LayerScopePreview url={selected.asset.displayUrl} sourceUrl={sourceAsset?.displayUrl} selection={config.pixelMode === 'source' ? { mode: 'whole' } : selection} background={selected.record.kind === 'background'} width={selected.record.width} height={selected.record.height} label={`透明图层 ${selected.record.name}`} />}
      </div>}
    </>}
    <div className="image-layering__actions">
      {generatedPlan.length > 0 && onRefreshJobs && <button type="button" disabled={refreshing} onClick={() => { void refreshJobs(); }}>{refreshing ? '正在同步…' : '同步任务状态'}</button>}
      <button type="button" disabled={!layered || !selection || exporting} onClick={() => { void exportPsd(); }}>{exporting ? '正在导出…' : '导出 PSD'}</button>
      <button type="button" disabled={!layered || !selection || exporting} onClick={() => { void openPsdInPhotoshop(); }}>在 Photoshop 中打开</button>
    </div>
    {exportError && <p role="alert">{exportError}</p>}
  </section>;
}

async function decodeManagedLayer(asset: ManagedImage, record: Pick<LayeredImageRecord, 'name' | 'width' | 'height'>): Promise<Uint8Array> {
  if (!asset.mediaType.startsWith('image/')) throw new Error(`图层 ${record.name} 不是图片`);
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = asset.displayUrl;
  await decodeImageWithTimeout(image);
  if (!compatibleLayerDimensions(image.naturalWidth, image.naturalHeight, record.width, record.height)) throw new Error(`图层 ${record.name} 的画幅比例与原图不符，不能拉伸合成`);
  const canvas = document.createElement('canvas');
  canvas.width = record.width;
  canvas.height = record.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前环境无法解码图层像素');
  try {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, record.width, record.height);
    return new Uint8Array(context.getImageData(0, 0, record.width, record.height).data);
  } finally { canvas.width = 0; canvas.height = 0; }
}
