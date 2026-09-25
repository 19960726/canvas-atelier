import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Image as ImageIcon, LoaderCircle } from 'lucide-react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import type { ModelJob } from '@agent-canvas/domain';
import { validateLayerPixels, type LayerQualityVerdict } from '../app/layering-quality';

type ManagedImage = Pick<ProjectImageAssetSummary, 'assetId' | 'displayUrl' | 'mediaType' | 'width' | 'height'>;

export function ImageLayerNodeWorkbench({ nodeId, config, asset, job, onQualityResult, onVisibilityChange }: {
  nodeId: string;
  config: Readonly<Record<string, unknown>>;
  asset?: ManagedImage;
  job?: ModelJob;
  onQualityResult: (assetId: string, verdict: LayerQualityVerdict) => void | Promise<void>;
  onVisibilityChange: (visible: boolean) => void | Promise<void>;
}) {
  const [validation, setValidation] = useState<'idle' | 'checking' | 'complete'>('idle');
  const validatingAsset = useRef<string | null>(null);
  const onQualityResultRef = useRef(onQualityResult);
  onQualityResultRef.current = onQualityResult;
  const layerName = typeof config.name === 'string' ? config.name : '图层';
  const layerKind = config.layerKind === 'background' ? 'background' : 'transparent';
  const resultAssetId = typeof config.resultAssetId === 'string' ? config.resultAssetId : null;
  const qualityStatus = typeof config.qualityStatus === 'string' ? config.qualityStatus : 'pending';
  const visible = config.visible !== false;

  useEffect(() => {
    if (!asset || resultAssetId !== asset.assetId || qualityStatus !== 'pending' || validatingAsset.current === asset.assetId) return;
    validatingAsset.current = asset.assetId;
    let cancelled = false;
    setValidation('checking');
    void readManagedPixels(asset).then(async ({ width, height, rgba }) => {
      if (cancelled) return;
      const expectedWidth = typeof config.canvasWidth === 'number' ? config.canvasWidth : width;
      const expectedHeight = typeof config.canvasHeight === 'number' ? config.canvasHeight : height;
      const verdict = await validateLayerPixels(layerKind, asset.mediaType, width, height, rgba, expectedWidth, expectedHeight);
      if (cancelled) return;
      setValidation('complete');
      await onQualityResultRef.current(asset.assetId, verdict);
    }).catch(async () => {
      if (cancelled) return;
      setValidation('complete');
      await onQualityResultRef.current(asset.assetId, { ok: false, reason: 'decode' });
    });
    return () => { cancelled = true; };
  }, [asset, config.canvasHeight, config.canvasWidth, layerKind, qualityStatus, resultAssetId]);

  const status = job?.status === 'failed' || job?.status === 'cancelled' ? job.status
    : qualityStatus === 'failed' ? 'failed'
      : qualityStatus === 'passed' ? 'completed'
        : job?.status === 'submitting' || job?.status === 'running' ? 'running'
          : job?.status === 'queued' || config.status === 'queued' ? 'queued'
            : job?.status === 'completed' || config.status === 'validating' ? 'validating' : 'planned';
  const statusText = status === 'planned' ? '等待任务' : status === 'queued' ? '排队中' : status === 'running' ? '生成中'
    : status === 'validating' ? (validation === 'checking' ? '验证像素…' : '等待像素验证')
      : status === 'completed' ? '像素验证通过' : status === 'cancelled' ? '任务已取消' : '需要检查';
  const qualityReason = typeof config.qualityReason === 'string' ? qualityReasonLabel(config.qualityReason) : undefined;
  const jobError = typeof job?.error === 'string' ? job.error : undefined;

  return <section className="image-layer-node nodrag" aria-label={`画布图层：${layerName}`} data-layer-status={status} data-layer-node-id={nodeId}>
    <div className="image-layer-node__preview">
      {asset && resultAssetId === asset.assetId
        ? <img src={asset.displayUrl} alt={`${layerName}图层预览`} loading="lazy" decoding="async" />
        : <span className="image-layer-node__placeholder" aria-hidden="true">{status === 'running' || status === 'queued' ? <LoaderCircle className="is-spinning" size={19} /> : <ImageIcon size={19} />}</span>}
      <span className="image-layer-node__kind">{layerKind === 'background' ? '背景' : '透明层'}</span>
    </div>
    <div className="image-layer-node__body">
      <div className="image-layer-node__heading"><strong title={layerName}>{layerName}</strong><span aria-live="polite" data-status={status}>{statusText}</span></div>
      {status === 'running' && job?.progress !== undefined && <div className="image-layer-node__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
      {(jobError || qualityReason) && <p className="image-layer-node__error" role="status">{qualityReason ?? jobError}</p>}
      <button className="image-layer-node__visibility" type="button" aria-pressed={visible} aria-label={`${visible ? '隐藏' : '显示'}图层 ${layerName}`} title={visible ? '隐藏图层' : '显示图层'} onClick={() => { void onVisibilityChange(!visible); }}><span>{visible ? <Eye size={14} /> : <EyeOff size={14} />}</span>{visible ? '可见' : '隐藏'}</button>
    </div>
  </section>;
}

async function readManagedPixels(asset: ManagedImage): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  if (!asset.mediaType.startsWith('image/')) throw new Error('Not an image');
  const image = new Image();
  image.src = asset.displayUrl;
  await image.decode();
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
