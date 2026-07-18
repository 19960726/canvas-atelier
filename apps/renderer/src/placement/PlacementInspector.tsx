import { Box, FlipHorizontal2, FlipVertical2, Image, Layers, Lock, Shapes, SunMedium, Unlock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PlacementBoard, PlacementObject, ReferenceRole } from '@agent-canvas/domain';

interface PlacementInspectorProps {
  value: PlacementBoard;
  selectedObjectId?: string;
  onChange: (value: PlacementBoard) => void;
  onUploadReference?: (role: Exclude<ReferenceRole, 'placement_preview'>) => void;
}

const roleOptions: Array<{ value: ReferenceRole; label: string }> = [
  { value: 'product_identity', label: '产品身份' },
  { value: 'scene_composition', label: '场景构图' },
  { value: 'prop_reference', label: '道具参考' },
  { value: 'material_lighting', label: '材质/光照' },
  { value: 'placement_preview', label: '摆放预览' },
];

const uploadFieldMeta: Record<string, { Icon: LucideIcon; role: ReferenceRole }> = {
  'upload-product': { Icon: Box, role: 'product_identity' },
  'upload-scene': { Icon: Image, role: 'scene_composition' },
  'upload-prop': { Icon: Shapes, role: 'prop_reference' },
  'upload-material': { Icon: SunMedium, role: 'material_lighting' },
};

export function PlacementInspector({ value, selectedObjectId, onChange, onUploadReference }: PlacementInspectorProps) {
  const selected = value.objects.find((object) => object.id === selectedObjectId);

  const updateSelected = (changes: Partial<PlacementObject>) => {
    if (!selected) return;
    onChange({
      ...value,
      objects: value.objects.map((object) => object.id === selected.id ? { ...object, ...changes } : object),
    });
  };

  return (
    <aside className="placement-inspector nodrag" aria-label="摆放检查器" data-testid="placement-inspector">
      <div className="placement-upload-grid">
        <UploadField dataTestId="upload-product" label="产品" ariaLabel="上传产品参考" onClick={() => onUploadReference?.('product_identity')} />
        <UploadField dataTestId="upload-scene" label="场景" ariaLabel="上传场景参考" onClick={() => onUploadReference?.('scene_composition')} />
        <UploadField dataTestId="upload-prop" label="道具" ariaLabel="上传道具参考" onClick={() => onUploadReference?.('prop_reference')} />
        <UploadField dataTestId="upload-material" label="材质" ariaLabel="上传材质光照参考" onClick={() => onUploadReference?.('material_lighting')} />
      </div>

      {selected ? (
        <div className="placement-properties">
          <div className="placement-properties__identity">
            <label>名称<input aria-label="对象名称" value={selected.name ?? ''} onChange={(event) => updateSelected({ name: event.target.value })} /></label>
            <label>参考职责
              <select aria-label="参考职责" value={selected.role} onChange={(event) => updateSelected({ role: event.target.value as ReferenceRole })}>
                {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <div className="placement-properties__transform">
            <label>旋转<input aria-label="旋转角度" type="number" min={-180} max={180} value={selected.rotation} disabled={selected.locked} onChange={(event) => updateSelected({ rotation: Number(event.target.value) })} /></label>
            <div className="placement-action-row">
              <button type="button" aria-label="水平翻转" title="水平翻转" disabled={selected.locked} onClick={() => updateSelected({ flipX: !selected.flipX })}><FlipHorizontal2 size={15} /></button>
              <button type="button" aria-label="垂直翻转" title="垂直翻转" disabled={selected.locked} onClick={() => updateSelected({ flipY: !selected.flipY })}><FlipVertical2 size={15} /></button>
            </div>
          </div>
          <div className="placement-properties__visibility">
            <div className="placement-toggle-row">
              <label><input aria-label="锁定对象" type="checkbox" checked={selected.locked} onChange={(event) => updateSelected({ locked: event.target.checked })} />{selected.locked ? <Lock size={14} /> : <Unlock size={14} />}锁定</label>
              <label><input aria-label="显示对象" type="checkbox" checked={selected.visible} onChange={(event) => updateSelected({ visible: event.target.checked })} />显示</label>
            </div>
          </div>
          <div className="placement-properties__layers">
            <div className="placement-action-row">
              <button type="button" aria-label="下移一层" title="下移一层" disabled={selected.locked || selected.zIndex <= 0} onClick={() => updateSelected({ zIndex: Math.max(0, selected.zIndex - 1) })}><Layers size={15} /></button>
              <button type="button" aria-label="上移一层" title="上移一层" disabled={selected.locked} onClick={() => updateSelected({ zIndex: selected.zIndex + 1 })}><Layers size={15} className="is-raised" /></button>
            </div>
          </div>
        </div>
      ) : <p className="placement-empty">选择一个对象后调整职责与图层。</p>}
    </aside>
  );
}

function UploadField({ dataTestId, label, ariaLabel, onClick }: { dataTestId: string; label: string; ariaLabel: string; onClick: () => void }) {
  const meta = uploadFieldMeta[dataTestId];
  const Icon = meta?.Icon ?? Image;

  return (
    <button type="button" data-testid={dataTestId} aria-label={ariaLabel} className={`placement-upload${meta ? ` role-${meta.role}` : ''}`} data-reference-role={meta?.role} onClick={onClick}>
      <Icon size={15} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
