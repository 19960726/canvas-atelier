import { useState } from 'react';
import { Layers3 } from 'lucide-react';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { useAppStore } from '../app/app-store';
import { restoreLayeringDraft } from '../app/layering-draft';
import { LayeringDialog } from './LayeringDialog';

export function MaterialLayeringAction({ nodeId, asset, label = 'AI 分层' }: {
  nodeId: string; asset: ProjectImageAssetSummary; label?: string;
}) {
  const projectId = useAppStore(state => state.project.id);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = Number.isInteger(asset.width) && Number.isInteger(asset.height) && (asset.width ?? 0) > 0 && (asset.height ?? 0) > 0;
  const currentOwner = () => {
    const state = useAppStore.getState();
    const node = state.project.nodes.find(candidate => candidate.id === nodeId);
    if (state.project.id !== projectId || node?.type !== 'module'
      || !(node.data.config.assetId === asset.assetId || (Array.isArray(node.data.config.assetIds) && node.data.config.assetIds.includes(asset.assetId)))) {
      throw new Error('素材或项目已变更，请重新打开 AI 分层');
    }
    return { state, node };
  };
  const owner = useAppStore.getState().project.nodes.find(candidate => candidate.id === nodeId);
  return <>
    <button type="button" className="image-layering__tool-icon nodrag nopan" aria-label={label}
      title={available ? '分析当前素材并检查分层方案' : '当前图片缺少有效尺寸信息，暂不可分层'} disabled={!available}
      onPointerDown={event => event.stopPropagation()} onClick={() => { setError(null); setOpen(true); }}>
      <Layers3 size={16} aria-hidden="true" /><span>AI 分层</span>
    </button>
    {error && <small role="alert">{error}</small>}
    {open && <LayeringDialog sourceAsset={asset}
      initialDraft={restoreLayeringDraft(asset.assetId, owner?.type === 'module' ? owner.data.config : {}, useAppStore.getState().project.nodes)}
      onDraftChange={draft => {
        try {
          const { state } = currentOwner();
          void state.draftImageLayering(nodeId, projectId, draft).then(saved => { if (!saved) setError('分层方案暂未保存，请检查项目保存状态'); }).catch(() => setError('分层方案保存失败'));
        } catch { setError('素材或项目已变更，请重新打开 AI 分层'); }
      }}
      onAnalyze={async input => {
        const { state } = currentOwner();
        const result = await state.analyzeImageLayering(input);
        currentOwner(); return result;
      }}
      onCreateGroup={input => currentOwner().state.createConfirmedLayeringGroup({ ...input, sourceNodeId: nodeId })}
      onStart={input => currentOwner().state.startConfirmedLayering(input)}
      onClose={() => setOpen(false)} />}
  </>;
}
