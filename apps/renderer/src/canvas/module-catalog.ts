import {
  listCanvasModuleDefinitions,
  type CanvasModuleDefinition,
} from '@agent-canvas/domain';
import type { ModulePreferences } from './module-preferences';

/* The UI Gate ships one canonical canvas vocabulary.  Older editing,
   storyboard, audio, Comfy and auxiliary Agent cards remain valid in the
   domain for opening existing projects, but they are no longer offered by
   the new module library/Quick Insert surface. */
const UI_GATE_MODULE_TYPES = new Set([
  'image_input',
  'upload_image',
  'video_input',
  'canvas_library',
  'text_prompt',
  'image_generation',
  'video_generation',
  'reverse_agent',
  'video_result',
  'reverse_result',
]);

export type ModuleCatalogCategory =
  | 'all'
  | 'favorites'
  | 'recent'
  | CanvasModuleDefinition['category'];

export const moduleCatalogCategories: ReadonlyArray<{
  id: ModuleCatalogCategory;
  label: string;
}> = [
  { id: 'all', label: '全部 / All' },
  { id: 'favorites', label: '收藏 / Favorites' },
  { id: 'recent', label: '最近 / Recent' },
  { id: 'input', label: '输入 / Input' },
  { id: 'generation', label: '生成 / Generation' },
  { id: 'editing', label: '编辑 / Editing' },
  { id: 'analysis', label: '分析 / Analysis' },
  { id: 'output', label: '输出 / Output' },
];

export function listFilteredModuleDefinitions(
  query: string,
  category: ModuleCatalogCategory,
  preferences: ModulePreferences,
): CanvasModuleDefinition[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return listDiscoverableModuleDefinitions().filter((definition) => {
    if (category === 'favorites' && !preferences.favorites.includes(definition.type)) return false;
    if (category === 'recent' && !preferences.recents.includes(definition.type)) return false;
    if (!['all', 'favorites', 'recent'].includes(category) && definition.category !== category) return false;
    if (normalizedQuery.length === 0) return true;
    return [
      definition.primaryName,
      definition.secondaryName,
      definition.description,
      definition.purpose,
      definition.usage,
      definition.limitations,
      definition.categoryDisplay.primaryName,
      definition.categoryDisplay.secondaryName,
      ...definition.searchAliases,
      ...definition.capabilities,
    ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
}

export function listDiscoverableModuleDefinitions(): CanvasModuleDefinition[] {
  return listCanvasModuleDefinitions().filter((definition) => UI_GATE_MODULE_TYPES.has(definition.type));
}
