import { FlipHorizontal2, FlipVertical2, Layers, Lock, Unlock } from 'lucide-react';
import type { ChangeEvent } from 'react';
import type { PlacementBoard, PlacementObject, ReferenceRole } from '@agent-canvas/domain';

interface PlacementInspectorProps {
  value: PlacementBoard;
  selectedObjectId?: string;
  onChange: (value: PlacementBoard) => void;
  onUploadReference?: (role: ReferenceRole, file: File) => void;
}

const roleOptions: Array<{ value: ReferenceRole; label: string }> = [
  { value: 'product_identity', label: '产品身份' },
  { value: 'scene_composition', label: '场景构图' },
  { value: 'prop_reference', label: '道具参考' },
  { value: 'material_lighting', label: '材质/光照' },
  { value: 'placement_preview', label: '摆放预览' },
];

export function PlacementInspector({ value, selectedObjectId, onChange, onUploadReference }: PlacementInspectorProps) {
  const selected = value.objects.find((object) => object.id === selectedObjectId);

  const updateSelected = (changes: Partial<PlacementObject>) => {
    if (!selected) return;
    onChange({
      ...value,
      objects: value.objects.map((object) => object.id === selected.id ? { ...object, ...changes } : object),
    });
  };

  const upload = (role: ReferenceRole) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onUploadReference?.(role, file);
    event.target.value = '';
  };

  return (
    <aside className="placement-inspector nodrag" aria-label="摆放检查器">
      <div className="placement-upload-grid">
        <UploadField dataTestId="upload-product" label="产品" ariaLabel="上传产品参考" onChange={upload('product_identity')} />
        <UploadField dataTestId="upload-scene" label="场景" ariaLabel="上传场景参考" onChange={upload('scene_composition')} />
        <UploadField dataTestId="upload-prop" label="道具" ariaLabel="上传道具参考" onChange={upload('prop_reference')} />
        <UploadField dataTestId="upload-material" label="材质" ariaLabel="上传材质光照参考" onChange={upload('material_lighting')} />
      </div>

      {selected ? (
        <div className="placement-properties">
          <label>名称<input aria-label="对象名称" value={selected.name ?? ''} onChange={(event) => updateSelected({ name: event.target.value })} /></label>
          <label>参考职责
            <select aria-label="参考职责" value={selected.role} onChange={(event) => updateSelected({ role: event.target.value as ReferenceRole })}>
              {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label>旋转<input aria-label="旋转角度" type="number" min={-180} max={180} value={selected.rotation} disabled={selected.locked} onChange={(event) => updateSelected({ rotation: Number(event.target.value) })} /></label>
          <div className="placement-toggle-row">
            <label><input aria-label="锁定对象" type="checkbox" checked={selected.locked} onChange={(event) => updateSelected({ locked: event.target.checked })} />{selected.locked ? <Lock size={14} /> : <Unlock size={14} />}锁定</label>
            <label><input aria-label="显示对象" type="checkbox" checked={selected.visible} onChange={(event) => updateSelected({ visible: event.target.checked })} />显示</label>
          </div>
          <div className="placement-action-row">
            <button type="button" aria-label="水平翻转" title="水平翻转" disabled={selected.locked} onClick={() => updateSelected({ flipX: !selected.flipX })}><FlipHorizontal2 size={15} /></button>
            <button type="button" aria-label="垂直翻转" title="垂直翻转" disabled={selected.locked} onClick={() => updateSelected({ flipY: !selected.flipY })}><FlipVertical2 size={15} /></button>
            <button type="button" aria-label="下移一层" title="下移一层" disabled={selected.locked || selected.zIndex <= 0} onClick={() => updateSelected({ zIndex: Math.max(0, selected.zIndex - 1) })}><Layers size={15} /></button>
            <button type="button" aria-label="上移一层" title="上移一层" disabled={selected.locked} onClick={() => updateSelected({ zIndex: selected.zIndex + 1 })}><Layers size={15} className="is-raised" /></button>
          </div>
        </div>
      ) : <p className="placement-empty">选择一个对象后调整职责与图层。</p>}
    </aside>
  );
}

function UploadField({ dataTestId, label, ariaLabel, onChange }: { dataTestId: string; label: string; ariaLabel: string; onChange: (event: ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <label className="placement-upload">
      <input data-testid={dataTestId} type="file" accept="image/*" aria-label={ariaLabel} onChange={onChange} />
      <span>{label}</span>
    </label>
  );
}
