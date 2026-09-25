import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, Layers3, LoaderCircle, X } from 'lucide-react';
import type { ProjectImageAssetSummary, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { confirmLayeringPlan, type LayeringPlan, type LayeringPlanLayer } from '../app/layering-plan';
import { eligibleForLayeringRoute, getLayeringRouteContract, PRODUCTION_LAYERING_ROUTE_EVIDENCE, type LayeringRouteEvidence } from '../app/layering-route-evidence';
import { IMAGE_RESOLUTION_TIERS, imageModelFamilyDisplayName, imageResolutionFamilyKey, resolveImageResolutionRoute } from '../app/image-resolution-routing';
import { listRunnableProviderProfiles } from '../app/provider-profiles';

type LayeringSourceImage = Pick<ProjectImageAssetSummary, 'assetId' | 'displayUrl' | 'label' | 'width' | 'height'>;
type Resolution = '1K' | '2K' | '4K';
type LayerCountMode = 'auto' | 'custom';
type RouteChoice = Pick<ProviderBridgeProfile, 'provider' | 'modelRoute'>;

function isGenericLayerName(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase().replace(/[\s_-]+/gu, ' ');
  return /^(?:主体|细节|前景|对象|图层)(?:层)?\s*\d*$/u.test(normalized)
    || /^(?:subject|detail|foreground|object|layer)(?: layer)?\s*\d*$/u.test(normalized);
}

export interface LayeringDialogProps {
  readonly sourceAsset: LayeringSourceImage | null;
  readonly onAnalyze: (input: {
    readonly sourceAssetId: string;
    readonly provider: ProviderBridgeProfile['provider'];
    readonly modelRoute: string;
    readonly width: number;
    readonly height: number;
    readonly mode?: LayerCountMode;
    readonly targetLayerCount?: number;
  }) => Promise<LayeringPlan>;
  readonly onCreateGroup: (input: { readonly plan: LayeringPlan; readonly confirmation: Awaited<ReturnType<typeof confirmLayeringPlan>>; readonly groupId: string }) => Promise<boolean>;
  readonly onStart: (input: { readonly plan: LayeringPlan; readonly confirmation: Awaited<ReturnType<typeof confirmLayeringPlan>>; readonly groupId: string }) => Promise<boolean>;
  readonly onClose: () => void;
  /** Deterministic local-test seam; production loads routes from the desktop bridge. */
  readonly profiles?: readonly ProviderBridgeProfile[];
  /** Deterministic local-test seam; production uses evidence reviewed into the app. */
  readonly routeEvidence?: readonly LayeringRouteEvidence[];
}

export function LayeringDialog({ sourceAsset, onAnalyze, onCreateGroup, onStart, onClose, profiles: suppliedProfiles, routeEvidence = PRODUCTION_LAYERING_ROUTE_EVIDENCE }: LayeringDialogProps) {
  const [profiles, setProfiles] = useState<readonly ProviderBridgeProfile[]>(suppliedProfiles ?? []);
  const [loadingProfiles, setLoadingProfiles] = useState(suppliedProfiles === undefined);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [analysisRoute, setAnalysisRoute] = useState('');
  const [generationRoute, setGenerationRoute] = useState('');
  const [resolution, setResolution] = useState<Resolution>('2K');
  const [layerCountMode, setLayerCountMode] = useState<LayerCountMode>('auto');
  const [targetLayerCount, setTargetLayerCount] = useState(5);
  const [plan, setPlan] = useState<LayeringPlan | null>(null);
  const [step, setStep] = useState<'analyze' | 'edit' | 'review'>('analyze');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdGroupId, setCreatedGroupId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    const controls = controlsRef.current;
    const review = reviewRef.current;
    if (step === 'review' && controls && review) {
      controls.scrollTop += review.getBoundingClientRect().top - controls.getBoundingClientRect().top - 16;
    }
  }, [step]);

  useEffect(() => {
    if (suppliedProfiles !== undefined) return;
    const provider = globalThis.window?.novusDesktop?.provider;
    if (!provider) {
      setProfileError('本地模型目录暂不可用，请检查模型配置。');
      setLoadingProfiles(false);
      return;
    }
    let current = true;
    void listRunnableProviderProfiles(provider).then((available) => {
      if (current) setProfiles(available);
    }).catch(() => {
      if (current) setProfileError('无法读取可用模型，请检查模型配置后重试。');
    }).finally(() => {
      if (current) setLoadingProfiles(false);
    });
    return () => { current = false; };
  }, [suppliedProfiles]);

  const visionProfiles = useMemo(() => profiles.filter((profile) => profile.capabilities.includes('vision')
    && profile.enabled !== false && profile.capabilityStatus !== 'incomplete'), [profiles]);
  const availableGptProfiles = useMemo(() => profiles.filter((profile) => eligibleForLayeringRoute(profile, routeEvidence)), [profiles, routeEvidence]);
  const visibleGptProfiles = useMemo(() => {
    const families = new Map<string, ProviderBridgeProfile>();
    for (const profile of availableGptProfiles) {
      const key = `${profile.provider}:${imageResolutionFamilyKey(profile)}`;
      const current = families.get(key);
      if (current === undefined || (current.displayName !== imageModelFamilyDisplayName(current) && profile.displayName === imageModelFamilyDisplayName(profile))) families.set(key, profile);
    }
    return [...families.values()];
  }, [availableGptProfiles]);
  const routeKey = (choice: RouteChoice) => `${choice.provider}::${choice.modelRoute}`;
  const selectedVisionProfile = visionProfiles.find((profile) => routeKey(profile) === analysisRoute) ?? visionProfiles[0];
  const selectedGptProfile = visibleGptProfiles.find((profile) => routeKey(profile) === generationRoute) ?? visibleGptProfiles[0];
  const resolutionRoutes = selectedGptProfile === undefined ? [] : IMAGE_RESOLUTION_TIERS.flatMap((tier) => {
    const profile = resolveImageResolutionRoute(availableGptProfiles, selectedGptProfile, tier);
    return profile && getLayeringRouteContract(profile, routeEvidence)?.resolutions.includes(tier) ? [{ tier, profile }] : [];
  });
  const resolutionOptions = resolutionRoutes.map(({ tier }) => tier);
  const generationProfile = resolutionRoutes.find(({ tier }) => tier === resolution)?.profile;
  const activePlan = plan;
  const includedCount = activePlan?.layers.filter((layer) => layer.included).length ?? 0;
  const genericLayer = activePlan?.layers.find((layer) => layer.kind === 'transparent' && isGenericLayerName(layer.name));
  const hasNamedLayers = activePlan?.layers.every((layer) => layer.name.trim().length > 0 && layer.name.trim().length <= 80) ?? false;
  const hasDescribedLayers = activePlan?.layers.every((layer) => layer.description.trim().length > 0 && layer.description.trim().length <= 1_000) ?? false;
  const planValid = activePlan !== null && activePlan.layers[0]?.kind === 'background' && activePlan.layers[0]?.included === true
    && activePlan.layers.some((layer) => layer.kind === 'transparent' && layer.included)
    && activePlan.layers.filter((layer) => layer.kind === 'transparent').length <= 11
    && hasNamedLayers && hasDescribedLayers && genericLayer === undefined;
  const planValidationMessage = genericLayer !== undefined
    ? '请将通用图层名改成具体产品、摆件或对应阴影名称后再继续。'
    : !hasDescribedLayers ? '请为每层填写包含范围和遮挡关系的说明。'
      : !hasNamedLayers ? '请为每个图层填写名称。'
        : '请保留背景层，并至少包含一个透明前景层。';

  useEffect(() => {
    if (resolutionOptions.length > 0 && !resolutionOptions.includes(resolution)) setResolution(resolutionOptions.includes('2K') ? '2K' : resolutionOptions[0]!);
  }, [resolution, resolutionOptions]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Tab' && dialogRef.current) {
        const candidates = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')];
        if (candidates.length === 0) return;
        const first = candidates[0]!;
        const last = candidates[candidates.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    globalThis.addEventListener('keydown', handleKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  const runAnalysis = async () => {
    if (!sourceAsset || selectedVisionProfile === undefined || busyRef.current) return;
    const width = sourceAsset.width;
    const height = sourceAsset.height;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      setError('源图缺少有效的像素尺寸，无法进行分层分析。');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setPlan(null);
    setCreatedGroupId(null);
    try {
      const nextPlan = await onAnalyze({ sourceAssetId: sourceAsset.assetId, provider: selectedVisionProfile.provider, modelRoute: selectedVisionProfile.modelRoute, width, height,
        mode: layerCountMode, ...(layerCountMode === 'custom' ? { targetLayerCount } : {}) });
      if (controlsRef.current) controlsRef.current.scrollTop = 0;
      setPlan(nextPlan);
      setStep('edit');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '图片分析失败，请重试。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const updateLayer = (layerId: string, patch: Partial<LayeringPlanLayer>) => {
    if (!activePlan) return;
    setPlan({ ...activePlan, layers: activePlan.layers.map((layer) => layer.layerId === layerId ? { ...layer, ...patch } : layer) });
    setStep('edit');
    setCreatedGroupId(null);
    setError(null);
  };

  const moveLayer = (index: number, direction: -1 | 1) => {
    if (!activePlan || index === 0 || index + direction < 1 || index + direction >= activePlan.layers.length) return;
    const layers = [...activePlan.layers];
    [layers[index], layers[index + direction]] = [layers[index + direction]!, layers[index]!];
    setPlan({ ...activePlan, layers });
    setStep('edit');
    setCreatedGroupId(null);
    setError(null);
  };

  const confirmAndStart = async () => {
    if (!activePlan || !generationProfile || !planValid || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const confirmation = await confirmLayeringPlan(activePlan, generationProfile.provider, generationProfile.modelRoute, resolution, new Date().toISOString());
      const groupId = createdGroupId ?? globalThis.crypto.randomUUID();
      if (createdGroupId === null) {
        const created = await onCreateGroup({ plan: activePlan, confirmation, groupId });
        if (!created) throw new Error('无法将分层节点保存到当前画布，请检查保存状态后重试。');
        setCreatedGroupId(groupId);
      }
      const started = await onStart({ plan: activePlan, confirmation, groupId });
      if (!started) throw new Error('分层任务没有启动；分层节点已保存在画布，可以稍后检查并重试。');
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '分层任务无法启动。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const modal = <div className="image-layering-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="image-layering-dialog" role="dialog" aria-modal="true" aria-labelledby="image-layering-dialog-title" aria-describedby="image-layering-dialog-subtitle" ref={dialogRef}>
      <header className="image-layering-dialog__header">
        <div className="image-layering-dialog__title"><span className="image-layering-dialog__icon"><Layers3 size={18} aria-hidden="true" /></span><div><h2 id="image-layering-dialog-title">AI 图片分层</h2><p id="image-layering-dialog-subtitle">按产品、每件摆件和对应阴影拆分；检查可编辑方案后才提交图层任务。</p></div></div>
        <button ref={closeRef} type="button" className="image-layering-dialog__close" aria-label="关闭 AI 图片分层" title="关闭" onClick={onClose}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="image-layering-dialog__body">
        <div className="image-layering-dialog__source-panel">
          <div className="image-layering-dialog__source-stage">
            {sourceAsset ? <><img src={sourceAsset.displayUrl} alt={`分层源图：${sourceAsset.label}`} /><div className="image-layering-dialog__source-stage-meta"><span>源图预览</span><small>原图只读</small></div></> : <div className="image-layering-dialog__no-source"><Layers3 size={26} /><span>请先在画布中选择一个可用的项目图片。</span></div>}
          </div>
          {sourceAsset && <div className="image-layering-dialog__source-meta"><strong>{sourceAsset.label || '项目图片'}</strong><span>{sourceAsset.width} × {sourceAsset.height} px</span></div>}
          <div className="image-layering-dialog__workflow" aria-label="分层流程"><span data-active={step === 'analyze'}>01 分析</span><i aria-hidden="true" /><span data-active={step === 'edit' || step === 'review'}>02 检查</span><i aria-hidden="true" /><span data-active={step === 'review'}>03 确认</span></div>
        </div>
        <div className="image-layering-dialog__controls" ref={controlsRef}>
          <section className="image-layering-dialog__section">
            <div className="image-layering-dialog__section-heading"><div><span className="image-layering-dialog__eyebrow">STEP 01 / 03</span><h3>分析图像内容</h3></div><span className="image-layering-dialog__badge">只分析</span></div>
            <div className="image-layering-dialog__mode" role="group" aria-label="图层数量模式">
              <button type="button" aria-pressed={layerCountMode === 'auto'} disabled={busy} onClick={() => { setLayerCountMode('auto'); setPlan(null); setStep('analyze'); setCreatedGroupId(null); }}>智能层数</button>
              <button type="button" aria-pressed={layerCountMode === 'custom'} disabled={busy} onClick={() => { setLayerCountMode('custom'); setPlan(null); setStep('analyze'); setCreatedGroupId(null); }}>自定义层数</button>
            </div>
            {layerCountMode === 'custom' ? <label className="image-layering-dialog__count-field"><span>目标图层数 <strong>{targetLayerCount} 层</strong></span><input type="range" min="2" max="12" step="1" aria-label="目标图层数" value={targetLayerCount} disabled={busy} onChange={(event) => { setTargetLayerCount(Number(event.target.value)); setPlan(null); setStep('analyze'); setCreatedGroupId(null); }} /><small>目标数供参考；按场景保留产品、每件摆件及各自阴影，不为凑数合并或编造图层。</small></label>
              : <p className="image-layering-dialog__hint">根据画面内容自动建议 2–12 层。分析后仍可检查名称、顺序和需要生成的图层。</p>}
            <label className="image-layering-dialog__field"><span>视觉分析模型</span><select aria-label="视觉分析模型" value={selectedVisionProfile ? routeKey(selectedVisionProfile) : ''} disabled={loadingProfiles || visionProfiles.length === 0} onChange={(event) => setAnalysisRoute(event.target.value)}>
              {visionProfiles.length === 0 && <option value="">{loadingProfiles ? '正在读取模型…' : '请先配置支持图片理解的模型'}</option>}
              {visionProfiles.map((profile) => <option key={routeKey(profile)} value={routeKey(profile)}>{profile.displayName} · {profile.provider}</option>)}
            </select></label>
            <div className="image-layering-dialog__phase-note"><span>当前阶段</span><strong>读取源图，返回可编辑分层方案</strong><small>分析完成后进入检查；确认后才提交 GPT Image 图层任务。</small></div>
            <p className="image-layering-dialog__hint">分析模型会读取选中的源图并返回可编辑的分层建议。模型调用可能产生费用；此步骤不会创建 GPT 图片任务。</p>
            <button className="image-layering-dialog__button image-layering-dialog__button--secondary" type="button" onClick={() => { void runAnalysis(); }} disabled={!sourceAsset || !selectedVisionProfile || busy || loadingProfiles}>
              {busy && step === 'analyze' ? <LoaderCircle className="is-spinning" size={15} /> : <Layers3 size={15} />}<span>{busy && step === 'analyze' ? '正在分析…' : plan ? '重新分析' : '分析图片'}</span>
            </button>
          </section>

          {activePlan && <section className="image-layering-dialog__section image-layering-dialog__plan-section">
            <div className="image-layering-dialog__section-heading"><div><span className="image-layering-dialog__eyebrow">STEP 02</span><h3>检查分层方案</h3></div><span className="image-layering-dialog__count">{includedCount} 个图层</span></div>
            <ol className="image-layering-dialog__layer-list" aria-label="可编辑分层方案">
              {activePlan.layers.map((layer, index) => <li key={layer.layerId} data-layer-kind={layer.kind}>
                <span className="image-layering-dialog__order">{String(index + 1).padStart(2, '0')}</span>
                <div className="image-layering-dialog__layer-fields"><input aria-label={`图层名称 ${layer.name}`} value={layer.name} maxLength={80} onChange={(event) => updateLayer(layer.layerId, { name: event.target.value })} /><small>{layer.kind === 'background' ? '背景 · 不透明底图' : '透明前景 · 独立像素层'}</small><textarea aria-label={`图层说明 ${layer.name}`} value={layer.description} maxLength={1_000} rows={2} onChange={(event) => updateLayer(layer.layerId, { description: event.target.value })} /></div>
                <div className="image-layering-dialog__layer-actions"><button type="button" aria-label={`上移图层 ${layer.name}`} disabled={index <= 1} title="上移" onClick={() => moveLayer(index, -1)}><ArrowUp size={14} /></button><button type="button" aria-label={`下移图层 ${layer.name}`} disabled={index === 0 || index === activePlan.layers.length - 1} title="下移" onClick={() => moveLayer(index, 1)}><ArrowDown size={14} /></button><button type="button" className="image-layering-dialog__include" aria-label={`${layer.included ? '排除' : '包含'}图层 ${layer.name}`} aria-pressed={layer.included} disabled={layer.kind === 'background'} title={layer.included ? '包含此层' : '排除'} onClick={() => updateLayer(layer.layerId, { included: !layer.included })}>{layer.included ? <Check size={14} /> : <span>—</span>}</button></div>
              </li>)}
            </ol>
            {!planValid && <p className="image-layering-dialog__validation" role="alert">{planValidationMessage}</p>}
            {step === 'edit' && <button className="image-layering-dialog__button image-layering-dialog__button--secondary" type="button" onClick={() => setStep('review')} disabled={!planValid || busy}>下一步：确认生成</button>}
          </section>}

          {step === 'review' && activePlan && <section ref={reviewRef} className="image-layering-dialog__section image-layering-dialog__review" aria-label="生成确认摘要">
            <div className="image-layering-dialog__section-heading"><div><span className="image-layering-dialog__eyebrow">STEP 03 / 03</span><h3>确认任务</h3></div><span className="image-layering-dialog__badge">确认后生成</span></div>
            <label className="image-layering-dialog__field"><span>GPT 图像模型</span><select aria-label="GPT 图像模型" value={selectedGptProfile ? routeKey(selectedGptProfile) : ''} disabled={visibleGptProfiles.length === 0 || busy} onChange={(event) => { setGenerationRoute(event.target.value); const selected = visibleGptProfiles.find((profile) => routeKey(profile) === event.target.value); const family = selected && availableGptProfiles.filter((profile) => profile.provider === selected.provider && imageResolutionFamilyKey(profile) === imageResolutionFamilyKey(selected)); const tiers = selected && family ? IMAGE_RESOLUTION_TIERS.filter((tier) => { const route = resolveImageResolutionRoute(family, selected, tier); return route && getLayeringRouteContract(route, routeEvidence)?.resolutions.includes(tier); }) : []; if (!tiers.includes(resolution)) setResolution(tiers.includes('2K') ? '2K' : tiers[0] ?? '1K'); setCreatedGroupId(null); }}>
              {availableGptProfiles.length === 0 && <option value="">请先配置支持透明编辑的 GPT Image 模型</option>}
              {visibleGptProfiles.map((profile) => <option key={routeKey(profile)} value={routeKey(profile)}>{imageModelFamilyDisplayName(profile)} · {profile.provider}</option>)}
            </select></label>
            {selectedGptProfile && <label className="image-layering-dialog__field"><span>输出分辨率</span><select aria-label="输出分辨率" value={resolution} disabled={busy} onChange={(event) => { setResolution(event.target.value as Resolution); setCreatedGroupId(null); }}>
              {resolutionOptions.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
            </select></label>}
            <div className="image-layering-dialog__summary"><span>分层模式<strong>{layerCountMode === 'custom' ? `自定义目标 ${targetLayerCount} 层` : '智能层数'}</strong></span><span>生成模型<strong>{generationProfile ? imageModelFamilyDisplayName(generationProfile) : selectedGptProfile ? imageModelFamilyDisplayName(selectedGptProfile) : '待验证 GPT Image 路由'}</strong></span><span>分辨率<strong>{resolution}</strong></span><span>任务数量<strong>{includedCount} 层 · {includedCount} 个单图任务</strong></span></div>
            {!selectedGptProfile && <p className="image-layering-dialog__validation" role="status">没有可用的 GPT Image 透明编辑模型。请在设置中配置并启用支持图片编辑的 Comfly GPT Image 模型后重新打开。</p>}
            {selectedGptProfile && <p className="image-layering-dialog__hint">前景逐层生成透明图片；返回后检查透明像素及画布尺寸，未通过的图层会标为需复核。</p>}
            <p className="image-layering-dialog__hint">点击“确认生成”后才会提交上方数量的图像任务。生成费用由所选服务商决定。</p>
            <button className="image-layering-dialog__button image-layering-dialog__button--primary" type="button" onClick={() => { void confirmAndStart(); }} disabled={!generationProfile || !planValid || busy}>
              {busy ? <LoaderCircle className="is-spinning" size={15} /> : <Check size={15} />}<span>{busy ? '正在保存并提交…' : `确认生成 ${includedCount} 层`}</span>
            </button>
          </section>}
          {(profileError || (!loadingProfiles && visionProfiles.length === 0)) && <p className="image-layering-dialog__validation" role="status">{profileError ?? '没有已配置且支持图片理解的视觉分析模型。'}</p>}
          {!loadingProfiles && profiles.length > 0 && availableGptProfiles.length === 0 && <p className="image-layering-dialog__notice" role="status">尚未配置可用的透明图片编辑模型；分层方案可以先分析和编辑。</p>}
          {error && <p className="image-layering-dialog__error" role="alert">{error}</p>}
        </div>
      </div>
      <footer className="image-layering-dialog__footer"><span>保留原图；每层独立为画布节点。透明像素和画布尺寸验证通过后才可导出 PSD。</span><button type="button" className="image-layering-dialog__button image-layering-dialog__button--quiet" onClick={onClose}>关闭</button></footer>
    </section>
  </div>;

  return createPortal(modal, document.body);
}
