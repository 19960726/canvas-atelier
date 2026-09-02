import { useMemo, useRef, useState } from 'react';
import {
  Search,
  Star,
  X,
} from 'lucide-react';
import {
  type CanvasModuleDefinition,
  type CanvasModuleType,
} from '@agent-canvas/domain';
import { resolveCanvasModuleIcon } from './module-icons';
import {
  listFilteredModuleDefinitions,
  listDiscoverableModuleDefinitions,
  moduleCatalogCategories,
  type ModuleCatalogCategory,
} from './module-catalog';
import {
  readModulePreferences,
  recordRecentModule,
  toggleModuleFavorite,
} from './module-preferences';

export const MODULE_DRAG_MIME = 'application/x-novus-module';

export function writeModuleDragPayload(
  event: React.DragEvent,
  type: CanvasModuleType,
): void {
  event.dataTransfer.setData(MODULE_DRAG_MIME, type);
  event.dataTransfer.effectAllowed = 'copy';
}

interface ModuleLibraryProps {
  onCreate: (moduleType: CanvasModuleType) => boolean | void | Promise<boolean | void>;
  onClose?: () => void;
}

export function ModuleLibrary({ onCreate, onClose }: ModuleLibraryProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModuleCatalogCategory>('all');
  const [selectedModuleType, setSelectedModuleType] = useState<CanvasModuleType | null>(null);
  const [preferences, setPreferences] = useState(() => readModulePreferences());
  const categoryTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activationInFlight = useRef(new Set<CanvasModuleType>());
  const definitions = useMemo(() => listDiscoverableModuleDefinitions(), []);
  const filteredDefinitions = useMemo(
    () => listFilteredModuleDefinitions(query, category, preferences),
    [category, preferences, query],
  );
  const selectedDefinition = selectedModuleType === null
    ? null
    : definitions.find((definition) => definition.type === selectedModuleType) ?? null;

  const createModule = async (moduleType: CanvasModuleType) => {
    if (activationInFlight.current.has(moduleType)) return;
    activationInFlight.current.add(moduleType);
    try {
      const created = await Promise.resolve(onCreate(moduleType));
      if (created === true) setPreferences(recordRecentModule(moduleType));
    } finally {
      activationInFlight.current.delete(moduleType);
    }
  };

  const moveCategory = (currentIndex: number, direction: 'first' | 'last' | 'next' | 'previous') => {
    const nextIndex = direction === 'first'
      ? 0
      : direction === 'last'
        ? moduleCatalogCategories.length - 1
        : direction === 'next'
          ? (currentIndex + 1) % moduleCatalogCategories.length
          : (currentIndex - 1 + moduleCatalogCategories.length) % moduleCatalogCategories.length;
    const nextCategory = moduleCatalogCategories[nextIndex];
    if (!nextCategory) return;
    setCategory(nextCategory.id);
    categoryTabRefs.current[nextIndex]?.focus();
  };

  return (
    <aside className="module-library" aria-label="模块库 / Module library" data-canvas-surface="module-library" data-figma-surface="module-library" data-testid="module-library">
      <header className="module-library__header">
        <div data-testid="module-library-heading">
          <strong>模块库</strong>
          <span>{filteredDefinitions.length} 个可用模块</span>
        </div>
        {onClose && (
          <button className="icon-button" type="button" data-testid="module-library-close" aria-label="关闭模块库" title="关闭模块库" onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </header>
      <label className="module-library__search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索模块"
          placeholder="搜索中文、English 或能力"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="module-library__categories" role="tablist" aria-label="模块分类" data-figma-tabs="segmented">
        {moduleCatalogCategories.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => { categoryTabRefs.current[index] = element; }}
            id={`module-category-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            aria-controls="module-category-panel"
            tabIndex={category === item.id ? 0 : -1}
            className={category === item.id ? 'is-active' : ''}
            onClick={() => setCategory(item.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') moveCategory(index, 'next');
              if (event.key === 'ArrowLeft') moveCategory(index, 'previous');
              if (event.key === 'Home') moveCategory(index, 'first');
              if (event.key === 'End') moveCategory(index, 'last');
              if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) event.preventDefault();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="module-library__list"
        id="module-category-panel"
        role="tabpanel"
        aria-labelledby={`module-category-tab-${category}`}
      >
        {filteredDefinitions.map((definition) => {
          const Icon = resolveCanvasModuleIcon(definition.type);
          return (
            <div key={definition.type} className={`module-library__item-row${selectedModuleType === definition.type ? ' is-selected' : ''}`}>
            <button
              type="button"
              className="module-library__item"
              aria-label={`查看 ${definition.primaryName} / ${definition.secondaryName}`}
              aria-selected={selectedModuleType === definition.type}
              draggable
              onClick={() => setSelectedModuleType(definition.type)}
              onDoubleClick={() => { void createModule(definition.type); }}
              onKeyDown={(event) => {
                if (event.repeat) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void createModule(definition.type);
                } else if (event.key === ' ') {
                  event.preventDefault();
                  setSelectedModuleType(definition.type);
                }
              }}
              onDragStart={(event) => writeModuleDragPayload(event, definition.type)}
            >
              <span
                className="module-library__item-icon"
                data-icon-category={definition.category}
                aria-hidden="true"
              >
                <Icon size={17} strokeWidth={1.8} />
              </span>
              <span className="module-library__item-copy">
                <strong>{definition.primaryName}</strong>
                <span>{definition.secondaryName}</span>
                <small>{definition.description}</small>
              </span>
            </button>
            <button
              type="button"
              className="module-library__favorite"
              aria-label={`${preferences.favorites.includes(definition.type) ? '取消收藏' : '收藏'} ${definition.primaryName} / ${definition.secondaryName}`}
              aria-pressed={preferences.favorites.includes(definition.type)}
              onClick={() => setPreferences(toggleModuleFavorite(definition.type))}
            >
              <Star size={14} fill={preferences.favorites.includes(definition.type) ? 'currentColor' : 'none'} />
            </button>
            </div>
          );
        })}
        {filteredDefinitions.length === 0 && (
          <div className="module-library__empty" role="status">没有匹配的模块</div>
        )}
      </div>
      {selectedDefinition && (
        <section className="module-library__details" role="region" aria-label="模块详情">
          <header><strong>{selectedDefinition.primaryName}</strong><span>{selectedDefinition.secondaryName}</span></header>
          <p>{selectedDefinition.description}</p>
          <dl>
            <div><dt>用途</dt><dd>{selectedDefinition.purpose}</dd></div>
            <div><dt>用法</dt><dd>{selectedDefinition.usage}</dd></div>
            <div><dt>限制</dt><dd>{selectedDefinition.limitations}</dd></div>
            <div><dt>输入</dt><dd>{formatPorts(selectedDefinition, 'input')}</dd></div>
            <div><dt>输出</dt><dd>{formatPorts(selectedDefinition, 'output')}</dd></div>
            <div><dt>执行</dt><dd>{selectedDefinition.executionMode}</dd></div>
            <div><dt>能力</dt><dd>{selectedDefinition.capabilities.join(' · ') || '本地'}</dd></div>
            <div><dt>下游</dt><dd>{selectedDefinition.recommendedDownstreamModuleTypes.join(' · ') || '无'}</dd></div>
          </dl>
        </section>
      )}
    </aside>
  );
}

function formatPorts(definition: CanvasModuleDefinition, direction: 'input' | 'output'): string {
  const labels = definition.ports
    .filter((port) => port.direction === direction)
    .map((port) => `${port.primaryLabel} / ${port.secondaryLabel}`);
  return labels.length === 0 ? '无' : labels.join(' · ');
}
