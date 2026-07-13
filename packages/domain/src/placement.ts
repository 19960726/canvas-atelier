import type { PlacementBoard, PlacementObject } from './project-schema';

const minimumPlacementSize = 0.02;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function percent(value: number): number {
  return Math.round(clamp(value, 0, 1) * 100);
}

function objectName(object: PlacementObject): string {
  if (object.name) {
    return object.name;
  }

  switch (object.role) {
    case 'product_identity': return '主产品';
    case 'scene_composition': return '场景构图';
    case 'prop_reference': return '道具';
    case 'material_lighting': return '材质与光照参考';
    case 'placement_preview': return '摆放参考';
  }
}

export function normalizePlacementObject(object: PlacementObject): PlacementObject {
  const w = clamp(object.w, minimumPlacementSize, 1);
  const h = clamp(object.h, minimumPlacementSize, 1);
  return {
    ...object,
    x: clamp(object.x, 0, 1 - w),
    y: clamp(object.y, 0, 1 - h),
    w,
    h,
    rotation: clamp(object.rotation, -180, 180),
  };
}

export function placementToPromptConstraints(placement: PlacementBoard): string[] {
  const constraints: string[] = [];

  for (const rawObject of placement.objects) {
    if (!rawObject.visible) {
      continue;
    }

    const object = normalizePlacementObject(rawObject);
    const name = objectName(object);
    const left = percent(object.x);
    const right = percent(object.x + object.w);
    const top = percent(object.y);
    const bottom = percent(object.y + object.h);
    const width = percent(object.w);
    const height = percent(object.h);

    constraints.push(`${name}位于画面水平 ${left}% 至 ${right}% 区间`);
    constraints.push(`${name}约占画面宽度 ${width}%`);
    constraints.push(`${name}位于画面垂直 ${top}% 至 ${bottom}% 区间`);
    constraints.push(`${name}约占画面高度 ${height}%`);
    constraints.push(`${name}位于${semanticLayerLabel(object.semanticLayer)}`);

    if (object.locked) {
      constraints.push(`锁定${name}的摆放位置与尺寸，摆放预览优先于场景构图`);
    }

    if (object.role === 'product_identity') {
      constraints.push(`保持${name}身份、外形、品牌颜色与标志可读性`);
    }

    if (object.rotation !== 0) {
      constraints.push(`${name}旋转 ${object.rotation} 度`);
    }

    if (object.flipX) {
      constraints.push(`${name}需要水平翻转`);
    }

    if (object.flipY) {
      constraints.push(`${name}需要垂直翻转`);
    }
  }

  for (const area of placement.board.safeAreas) {
    if (area.purpose !== 'copy_safe') {
      continue;
    }
    const start = percent(area.y);
    const end = percent(area.y + area.h);
    const region = area.y < 0.34 ? '顶部' : area.y > 0.66 ? '底部' : '中部';
    constraints.push(`${region} ${start}% 至 ${end}% 为文案安全区，禁止产品和道具侵入`);
  }

  return constraints;
}

function semanticLayerLabel(layer: PlacementObject['semanticLayer']): string {
  switch (layer) {
    case 'foreground': return '前景层';
    case 'midground': return '中景层';
    case 'background': return '背景层';
    case 'hero_product': return '主视觉产品层';
    case 'optional_prop': return '可选道具层';
  }
}