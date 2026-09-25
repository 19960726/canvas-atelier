import { useMemo, useState } from 'react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import type { CanvasModuleNode, ModelJob } from '@agent-canvas/domain';
import { encodeLayeredPsd, type LayeredPsdDocument } from '../app/layered-psd';
import { parseLayeredImageConfig, type LayeredImageRecord } from '../app/layered-image-config';

type ManagedImage = Pick<ProjectImageAssetSummary, 'assetId' | 'mediaType' | 'displayUrl'>;

export function ImageLayeringWorkbench({ config, assets, layerNodes = [], jobs = [], onLayersChange, onRefreshJobs, onRetryJob, canRetryJob }: {
  config: Readonly<Record<string, unknown>>;
  assets: readonly ManagedImage[];
  layerNodes?: readonly CanvasModuleNode[];
  jobs?: readonly ModelJob[];
  onLayersChange: (layers: LayeredImageRecord[]) => void | Promise<void>;
  onRefreshJobs?: () => Promise<void>;
  onRetryJob?: (jobId: string) => Promise<void>;
  canRetryJob?: (job: ModelJob) => boolean;
}) {
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<'original' | 'composite'>('composite');
  const [exporting, setExporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryCandidateId, setRetryCandidateId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const generatedConfig = useMemo(() => {
    if ((Array.isArray(config.layers) && config.layers.length > 0) || !Array.isArray(config.planLayers)) return config;
    const planLayers = config.planLayers.filter((layer): layer is Record<string, unknown> => typeof layer === 'object' && layer !== null && !Array.isArray(layer));
    const sortedNodes = [...layerNodes].sort((left, right) => Number(left.data.config.order ?? Number.MAX_SAFE_INTEGER) - Number(right.data.config.order ?? Number.MAX_SAFE_INTEGER));
    const nodesByLayer = new Map(sortedNodes.map((node) => [node.data.config.layerId, node]));
    const records = planLayers.map((layer, index) => {
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
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const passedCount = generatedPlan.filter((layer) => layerStatusById.get(layer.layerId)?.qualityStatus === 'passed').length;
  const failedCount = generatedPlan.filter((layer) => {
    const layerConfig = layerStatusById.get(layer.layerId);
    const job = typeof layerConfig?.jobId === 'string' ? jobsById.get(layerConfig.jobId) : undefined;
    return layerConfig?.qualityStatus === 'failed' || job?.status === 'failed' || job?.status === 'cancelled';
  }).length;
  const overallStatus = generatedPlan.length > 0 && passedCount === generatedPlan.length ? '已完成'
    : failedCount > 0 ? '需复核' : generatedPlan.length > 0 ? '进行中' : '等待任务';
  const layered = parsed.document;
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
      void Promise.resolve(onLayersChange(next)).catch(error => {
        setExportError(error instanceof Error ? error.message : '图层保存失败');
      });
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '图层保存失败');
    }
  };
  const moveLayer = (index: number, direction: -1 | 1) => {
    if (!layered || index === 0 || index + direction < 1 || index + direction >= layered.layers.length) return;
    const next = layered.layers.map(layer => layer.record);
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    changeLayers(next);
  };
  const buildPsdBytes = async (): Promise<Uint8Array> => {
    if (!layered) throw new Error('尚无可导出的分层结果');
    const decoded: LayeredPsdDocument = {
        width: layered.canvasWidth,
        height: layered.canvasHeight,
        layers: await Promise.all(layered.layers.map(async ({ record, asset }) => ({
          id: record.layerId,
          kind: record.kind,
          name: record.name,
          x: record.x,
          y: record.y,
          width: record.width,
          height: record.height,
          visible: record.visible,
          opacity: record.opacity,
          rgba: await decodeManagedLayer(asset, record),
        }))),
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
    {generatedPlan.length > 0 && <div className="image-layering__progress-heading" role="status"><strong>已验证 {passedCount} / {generatedPlan.length} 层</strong><span>{overallStatus}</span></div>}
    {sourceAsset && <div className="image-layering__view-controls" role="group" aria-label="分层预览模式">
      <button type="button" aria-pressed={previewMode === 'original' || layered === null} onClick={() => setPreviewMode('original')}>原图</button>
      <button type="button" aria-pressed={previewMode === 'composite' && layered !== null} disabled={layered === null} onClick={() => setPreviewMode('composite')}>合成图</button>
    </div>}
    {layered === null ? <div className="image-layering__empty">
      {sourceAsset && <img className="image-layering__source-preview" src={sourceAsset.displayUrl} alt="原图预览" draggable={false} />}
      <span>{generatedPlan.length > 0 ? '独立图层会在任务完成并通过像素验证后显示在合成预览中。' : '连接一张图片，或从图片工具栏使用 AI 分层。'}</span>
      {generatedPlan.length > 0 && <ol className="image-layering__progress-list" aria-label="分层任务进度">{generatedPlan.map((layer) => {
        const layerConfig = layerStatusById.get(layer.layerId);
        const job = typeof layerConfig?.jobId === 'string' ? jobsById.get(layerConfig.jobId) : undefined;
        const status = layerConfig?.qualityStatus === 'failed' ? '像素验证失败'
          : layerConfig?.qualityStatus === 'passed' ? '验证通过'
            : job?.status === 'failed' ? '任务失败'
              : job?.status === 'cancelled' ? '已取消'
                : job?.status === 'running' || job?.status === 'submitting' || layerConfig?.status === 'running' ? '生成中'
                  : job?.status === 'completed' || layerConfig?.status === 'validating' ? '验证中'
                    : job?.status === 'queued' || layerConfig?.status === 'queued' ? '排队中' : '等待任务';
        return <li key={String(layer.layerId)}><span>{String(layer.name ?? '图层')}</span><b>{status}</b>
          {(job?.status === 'failed' || job?.status === 'cancelled') && onRetryJob && <button type="button"
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
          : layered.layers.filter(layer => layer.record.visible).map(({ record, asset }) => <img
          key={record.layerId}
          src={asset.displayUrl}
          alt={`合成预览图层 ${record.name}`}
          draggable={false}
          style={{ left: `${record.x / layered.canvasWidth * 100}%`, top: `${record.y / layered.canvasHeight * 100}%`,
            width: `${record.width / layered.canvasWidth * 100}%`, height: `${record.height / layered.canvasHeight * 100}%`, opacity: record.opacity }}
        />)}
      </div>
      <ol className="image-layering__list" aria-label="分层图层">
        {layered.layers.map(({ record, asset }, index) => <li key={record.layerId}>
          <button type="button" className="image-layering__thumbnail" aria-label={`预览图层 ${record.name}`} onClick={() => setSelectedLayerId(record.layerId)}>
            <img src={asset.displayUrl} alt="" draggable={false} />
          </button>
          <span className="image-layering__name">{index + 1}. {record.name}</span>
          <button type="button" aria-label={`${record.visible ? '隐藏' : '显示'}图层 ${record.name}`} onClick={() => changeLayers(layered.layers.map((layer, layerIndex) => layerIndex === index
            ? { ...layer.record, visible: !layer.record.visible } : layer.record))}>{record.visible ? '可见' : '隐藏'}</button>
          <button type="button" aria-label={`下移图层 ${record.name}`} disabled={index <= 1} onClick={() => moveLayer(index, -1)}>↓</button>
          <button type="button" aria-label={`上移图层 ${record.name}`} disabled={index === 0 || index === layered.layers.length - 1} onClick={() => moveLayer(index, 1)}>↑</button>
        </li>)}
      </ol>
      {selected && <div className="image-layering__single" aria-label={`透明层预览 ${selected.record.name}`}>
        <img src={selected.asset.displayUrl} alt={`透明图层 ${selected.record.name}`} draggable={false} />
      </div>}
    </>}
    <div className="image-layering__actions">
      {generatedPlan.length > 0 && onRefreshJobs && <button type="button" disabled={refreshing} onClick={() => { void refreshJobs(); }}>{refreshing ? '正在同步…' : '同步任务状态'}</button>}
      <button type="button" disabled={!layered || exporting} onClick={() => { void exportPsd(); }}>{exporting ? '正在导出…' : '导出 PSD'}</button>
      <button type="button" disabled={!layered || exporting} onClick={() => { void openPsdInPhotoshop(); }}>在 Photoshop 中打开</button>
    </div>
    {exportError && <p role="alert">{exportError}</p>}
  </section>;
}

async function decodeManagedLayer(asset: ManagedImage, record: LayeredImageRecord): Promise<Uint8Array> {
  if (!asset.mediaType.startsWith('image/')) throw new Error(`图层 ${record.name} 不是图片`);
  const image = new Image();
  image.src = asset.displayUrl;
  await image.decode();
  if (image.naturalWidth !== record.width || image.naturalHeight !== record.height) throw new Error(`图层 ${record.name} 的像素尺寸不符`);
  const canvas = document.createElement('canvas');
  canvas.width = record.width;
  canvas.height = record.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('当前环境无法解码图层像素');
  context.drawImage(image, 0, 0);
  return new Uint8Array(context.getImageData(0, 0, record.width, record.height).data);
}
