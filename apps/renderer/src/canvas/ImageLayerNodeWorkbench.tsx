import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Image as ImageIcon, LoaderCircle } from 'lucide-react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import type { ModelJob } from '@agent-canvas/domain';
import { validateLayerPixels, type LayerQualityVerdict } from '../app/layering-quality';
import { applyLayerSelection, readLayeringSelection } from '../app/layering-selection';
import { LayerScopePreview } from './LayerScopePreview';
import { SourceForegroundPreview } from './SourceForegroundPreview';
import { useSourceLayerPreview, type SourceLayerInput } from './source-layer-preview';
import { decodeImageWithTimeout } from '../app/decode-image-timeout';
import { getLayerPixelRepresentation } from '../app/layer-pixel-representation';

type ManagedImage = Pick<ProjectImageAssetSummary, 'assetId' | 'displayUrl' | 'mediaType' | 'width' | 'height'>
  & Partial<Pick<ProjectImageAssetSummary, 'sha256'>>;

export function ImageLayerNodeWorkbench({ nodeId, config, asset, sourceAsset, job, onQualityResult, onVisibilityChange, onRefreshAsset, onReplaceAsset, validatePixels = true, sourceDocumentInput = null }: {
  nodeId: string;
  config: Readonly<Record<string, unknown>>;
  asset?: ManagedImage;
  sourceAsset?: ManagedImage;
  validatePixels?: boolean;
  sourceDocumentInput?: SourceLayerInput | null;
  job?: ModelJob;
  onQualityResult: (assetId: string, verdict: LayerQualityVerdict) => void | Promise<void>;
  onVisibilityChange: (visible: boolean) => void | Promise<void>;
  onRefreshAsset?: () => void | Promise<void>;
  onReplaceAsset?: (file: File) => Promise<void>;
}) {
  const [validation, setValidation] = useState<'idle' | 'checking' | 'complete'>('idle');
  const [assetLoadFailed, setAssetLoadFailed] = useState(false);
  const [validationSaveFailed, setValidationSaveFailed] = useState(false);
  const [retryValidation, setRetryValidation] = useState(0);
  const [replacingAsset, setReplacingAsset] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const [extractionFailure, setExtractionFailure] = useState<{ key: string; error: string | null } | null>(null);
  const representation = getLayerPixelRepresentation(config, sourceAsset, asset);
  const independentRgbaCandidate = representation.independentRgbaCandidate;
  const extractSourceColors = !representation.preparedRgb && !independentRgbaCandidate && !representation.error;
  const extractionKey = JSON.stringify([asset?.displayUrl, sourceAsset?.displayUrl, config.sourceBounds, config.layerSelection,
    config.maskSpace, independentRgbaCandidate, config.foregroundProvenance, asset?.sha256, sourceAsset?.sha256]);
  const validatingAsset = useRef<string | null>(null);
  const onQualityResultRef = useRef(onQualityResult);
  onQualityResultRef.current = onQualityResult;
  const layerName = typeof config.name === 'string' ? config.name : '图层';
  const layerKind = config.layerKind === 'background' ? 'background' : 'transparent';
  const resultAssetId = typeof config.resultAssetId === 'string' ? config.resultAssetId : null;
  const qualityStatus = typeof config.qualityStatus === 'string' ? config.qualityStatus : 'pending';
  const visible = config.visible !== false;
  const scope = (() => { try { return readLayeringSelection(config.layerSelection); } catch { return null; } })();
  const backgroundPreview = useSourceLayerPreview(sourceDocumentInput);
  const preparedLayer = backgroundPreview.preview?.layers.find(layer => layer.record.layerId === config.layerId);

  useEffect(() => {
    if (!resultAssetId || asset || !onRefreshAsset) return;
    let cancelled = false;
    setAssetLoadFailed(false);
    void Promise.resolve().then(onRefreshAsset).then(() => {
      if (!cancelled) setAssetLoadFailed(true);
    }).catch(() => {
      if (!cancelled) setAssetLoadFailed(true);
    });
    return () => { cancelled = true; };
  }, [asset, onRefreshAsset, resultAssetId]);

  useEffect(() => {
    const oldResolutionFailure = qualityStatus === 'failed' && config.qualityReason === 'dimensions' && config.qualityValidationVersion !== 2;
    if (!validatePixels || !asset || resultAssetId !== asset.assetId || (qualityStatus !== 'pending' && !oldResolutionFailure) || validatingAsset.current === asset.assetId) return;
    validatingAsset.current = asset.assetId;
    let cancelled = false;
    setValidationSaveFailed(false);
    setValidation('checking');
    void validateManagedImageLayer(asset, config, !!sourceAsset).then(async (verdict) => {
      if (cancelled || verdict === undefined) return;
      setValidation('complete');
      try { await onQualityResultRef.current(asset.assetId, verdict); }
      catch { if (!cancelled) setValidationSaveFailed(true); }
    });
    return () => {
      cancelled = true;
      if (validatingAsset.current === asset.assetId) validatingAsset.current = null;
    };
  }, [validatePixels, asset, sourceAsset, config.canvasHeight, config.canvasWidth, config.pixelMode, config.layerSelection, config.qualityReason, config.qualityValidationVersion, layerKind, qualityStatus, resultAssetId, retryValidation]);

  const extractionError = (!sourceDocumentInput || backgroundPreview.error) && config.pixelMode === 'source' && extractSourceColors
    && extractionFailure?.key === extractionKey ? extractionFailure.error : null;
  const contentOverlap = typeof backgroundPreview.error === 'string' && backgroundPreview.error.includes('内容重叠');
  const status = representation.error || backgroundPreview.error || extractionError ? 'blocked' : job?.status === 'failed' || job?.status === 'cancelled' ? job.status
    : qualityStatus === 'failed' ? 'failed'
      : qualityStatus === 'passed' ? 'completed'
        : job?.status === 'submitting' || job?.status === 'running' ? 'running'
          : job?.status === 'queued' || config.status === 'queued' ? 'queued'
            : job?.status === 'completed' || config.status === 'validating' ? 'validating' : 'planned';
  const statusText = status === 'blocked' ? contentOverlap ? '内容重叠 · 图片已返回' : '合成受阻 · 图片已返回' : status === 'planned' ? '等待任务' : status === 'queued' ? '排队中' : status === 'running' ? '生成中'
    : status === 'validating' ? !asset && resultAssetId ? assetLoadFailed ? '图片读取失败' : '图片已返回，正在读取'
      : validationSaveFailed ? '验证结果保存失败' : validation === 'checking' ? '检查透明像素…' : '检查透明像素'
      : status === 'completed' ? '格式检查通过 · 待检查边缘' : status === 'cancelled' ? '任务已取消' : '需要检查';
  const qualityReason = config.qualityReason === 'dimensions' && asset
    ? `图片已返回 ${asset.width ?? '?'} × ${asset.height ?? '?'}；原图为 ${config.canvasWidth} × ${config.canvasHeight}，画幅比例不符，不能直接对齐合成。请按原图比例重新生成此层。`
    : typeof config.qualityReason === 'string' ? qualityReasonLabel(config.qualityReason) : undefined;
  const jobError = typeof job?.error === 'string' ? job.error : undefined;

  return <section className="image-layer-node nodrag" aria-label={`画布图层：${layerName}`} data-layer-status={status} data-layer-node-id={nodeId}>
    <div className="image-layer-node__preview">
      {asset && resultAssetId === asset.assetId && scope
        ? config.pixelMode === 'source' && sourceDocumentInput
          ? preparedLayer ? <div className="image-layer-node__source-frame" style={{ aspectRatio: `${sourceDocumentInput.width}/${sourceDocumentInput.height}`,
              maxWidth: 170 * sourceDocumentInput.width / sourceDocumentInput.height }}>
              <img src={preparedLayer.asset.displayUrl} alt={`${layerName}图层预览`} draggable={false} style={{ position: 'absolute',
                left: `${preparedLayer.record.x / sourceDocumentInput.width * 100}%`, top: `${preparedLayer.record.y / sourceDocumentInput.height * 100}%`,
                width: `${preparedLayer.record.width / sourceDocumentInput.width * 100}%`, height: `${preparedLayer.record.height / sourceDocumentInput.height * 100}%` }} />
            </div> : backgroundPreview.error
              ? layerKind === 'transparent' && extractSourceColors && sourceAsset
                ? <SourceForegroundPreview sourceUrl={sourceAsset.displayUrl} maskUrl={asset.displayUrl} bounds={config.sourceBounds} selection={scope}
                    onError={error => setExtractionFailure({ key: extractionKey, error })}
                    maskSpace={config.maskSpace === 'source' ? 'source' : 'bounds'}
                    width={sourceAsset.width ?? Number(config.canvasWidth)} height={sourceAsset.height ?? Number(config.canvasHeight)} label={`${layerName}图层预览`} />
                : <img src={asset.displayUrl} alt={`${layerName}已返回原始图片，尚未合成`} draggable={false} />
              : <span role="status">正在处理图层像素…</span>
          : config.pixelMode === 'source' && layerKind === 'background'
          ? backgroundPreview.preview ? <img src={backgroundPreview.preview.layers[0]!.asset.displayUrl} alt={`${layerName}图层预览`} draggable={false} />
            : <span role="status">{backgroundPreview.error ?? (sourceDocumentInput ? '正在保留原图背景像素…' : '等待前景蒙版完成背景补全')}</span>
          : config.pixelMode === 'source' && extractSourceColors && layerKind === 'transparent' && sourceAsset
          ? <SourceForegroundPreview sourceUrl={sourceAsset.displayUrl} maskUrl={asset.displayUrl} bounds={config.sourceBounds} selection={scope}
            onError={error => setExtractionFailure({ key: extractionKey, error })}
            maskSpace={config.maskSpace === 'source' ? 'source' : 'bounds'}
            independentRgba={independentRgbaCandidate}
            width={sourceAsset.width ?? Number(config.canvasWidth)} height={sourceAsset.height ?? Number(config.canvasHeight)} label={`${layerName}图层预览`} />
          : <LayerScopePreview url={asset.displayUrl} sourceUrl={sourceAsset?.displayUrl} selection={scope} background={layerKind === 'background'}
          width={asset.width ?? 1} height={asset.height ?? 1} label={`${layerName}图层预览`} />
        : <span className="image-layer-node__placeholder" aria-hidden="true">{status === 'running' || status === 'queued' ? <LoaderCircle className="is-spinning" size={19} /> : <ImageIcon size={19} />}</span>}
      <span className="image-layer-node__kind">{layerKind === 'background' ? '背景' : '透明层'}</span>
    </div>
    <div className="image-layer-node__body">
      {backgroundPreview.error && <details className="image-layer-node__error"><summary>{contentOverlap ? '查看图层内容重叠原因' : '查看图层失败原因'}</summary><p>{backgroundPreview.error}</p><p>本层返图已保留。请在分层工作台检查提示中的图层和背景。</p></details>}
      <div className="image-layer-node__heading"><strong title={layerName}>{layerName}</strong><span aria-live="polite" data-status={status} title={status === 'completed' ? '图片格式、画幅及透明通道已检查；提取范围和边缘请对照原图确认。' : undefined}>{statusText}</span></div>
      {status === 'running' && job?.progress !== undefined && <div className="image-layer-node__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
      {(jobError || qualityReason) && <p className="image-layer-node__error" role="status">{qualityReason ?? jobError}</p>}
      {!scope && <p role="alert">保存的分层范围无效，请重新选择。</p>}
      {representation.error && <p className="image-layer-node__error" role="alert">{representation.error}</p>}
      {assetLoadFailed && !asset && resultAssetId && <button type="button" onClick={() => { setAssetLoadFailed(false); void onRefreshAsset?.(); }}>重新读取图片</button>}
      {validationSaveFailed && <button type="button" onClick={() => { validatingAsset.current = null; setRetryValidation((value) => value + 1); }}>重试本地验证</button>}
      <div className="image-layer-node__actions">
        <button className="image-layer-node__visibility" type="button" aria-pressed={visible} aria-label={`${visible ? '隐藏' : '显示'}图层 ${layerName}`} title={visible ? '隐藏图层' : '显示图层'} onClick={() => { void onVisibilityChange(!visible); }}><span>{visible ? <Eye size={14} /> : <EyeOff size={14} />}</span>{visible ? '可见' : '隐藏'}</button>
        {onReplaceAsset && <>
          <input ref={replacementInput} type="file" accept="image/png" aria-label="选择替换图层 PNG" hidden
            disabled={replacingAsset || job?.status === 'queued' || job?.status === 'submitting' || job?.status === 'running'}
            onChange={event => {
              const file = event.target.files?.[0]; event.currentTarget.value = '';
              if (!file || replacingAsset) return;
              setReplacingAsset(true); setReplaceError(null);
              void Promise.resolve().then(() => onReplaceAsset(file)).catch(error => {
                setReplaceError(error instanceof Error ? error.message : '图层素材替换失败');
              }).finally(() => setReplacingAsset(false));
            }} />
          <button className="image-layer-node__visibility" type="button"
            title="导入按原图完整尺寸保存的 PNG 图层，替换后重新检查"
            disabled={replacingAsset || job?.status === 'queued' || job?.status === 'submitting' || job?.status === 'running'}
            onClick={() => replacementInput.current?.click()}>{replacingAsset ? '正在替换…' : '替换图层素材'}</button>
        </>}
      </div>
      {replaceError && <p className="image-layer-node__error" role="alert">{replaceError}</p>}
    </div>
  </section>;
}

export function needsLayerPixelValidation(config: Readonly<Record<string, unknown>>): boolean {
  // Semantic review may remain pending after the current returned bytes have
  // passed format checks. That candidate must release the serial pixel queue.
  if (typeof config.resultAssetId === 'string' && config.formatQualityStatus === 'passed'
    && config.qualityFormatCheckedAssetId === config.resultAssetId && config.qualityValidationVersion === 2) return false;
  return typeof config.resultAssetId === 'string' && (config.qualityStatus === 'pending' || config.qualityStatus === undefined
    || (config.qualityStatus === 'failed' && config.qualityReason === 'dimensions' && config.qualityValidationVersion !== 2));
}

export async function validateManagedImageLayer(asset: ManagedImage, config: Readonly<Record<string, unknown>>, hasSource: boolean): Promise<LayerQualityVerdict> {
  try {
    const { width, height, rgba } = await readManagedPixels(asset);
    const expectedWidth = typeof config.canvasWidth === 'number' ? config.canvasWidth : width;
    const expectedHeight = typeof config.canvasHeight === 'number' ? config.canvasHeight : height;
    const kind = config.layerKind === 'background' ? 'background' : 'transparent';
    const selection = readLayeringSelection(config.layerSelection);
    const verdict = await validateLayerPixels(kind, asset.mediaType, width, height, rgba, expectedWidth, expectedHeight);
    if (!verdict.ok || selection.mode === 'whole') return verdict;
    if (kind === 'background') return hasSource ? verdict : { ok: false, reason: 'decode' };
    // Source masks are placed at sourceBounds before selection clipping. Provider
    // coordinates cannot establish whether the selected original object is empty.
    if (config.pixelMode === 'source') return verdict;
    return validateLayerPixels(kind, asset.mediaType, width, height, applyLayerSelection(rgba, width, height, selection), expectedWidth, expectedHeight);
  } catch { return { ok: false, reason: 'decode' }; }
}

async function readManagedPixels(asset: ManagedImage): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  if (!asset.mediaType.startsWith('image/')) throw new Error('Not an image');
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = asset.displayUrl;
  await decodeImageWithTimeout(image);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8_192 || height > 8_192 || width * height * 4 > 256 * 1024 * 1024) {
    throw new Error('Image dimensions exceed the pixel validation budget');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas is unavailable');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    return { width, height, rgba: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function qualityReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    decode: '图片解码失败，不能导出 PSD。',
    media_type: '图层格式不是 PNG/WebP，不能验证透明像素。',
    dimensions: '图层尺寸与原图画布不一致，请检查模型结果。',
    alpha_empty: '图层没有可见像素，请重新生成。',
    alpha_opaque: '透明层没有透明像素，不能作为独立前景层。',
    background_holes: '背景层包含透明空洞，不能作为完整底图。',
  };
  return labels[reason] ?? '图层未通过像素验证。';
}
