import {
  listCanvasModuleDefinitions,
  type CanvasModuleDefinition,
} from '@agent-canvas/domain';
import type { ModulePreferences } from './module-preferences';

const AGENT_CAPABILITY_MODULE_TYPES = new Set([
  'skill_agent',
  'detail_page_agent',
  'line_art_material',
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
  return listCanvasModuleDefinitions().filter((definition) => (
    !AGENT_CAPABILITY_MODULE_TYPES.has(definition.type)
  ));
}
