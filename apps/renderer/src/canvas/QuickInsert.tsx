import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search, Star, X } from 'lucide-react';
import type { CanvasModuleType } from '@agent-canvas/domain';
import { resolveCanvasModuleIcon } from './module-icons';
import {
  listFilteredModuleDefinitions,
  moduleCatalogCategories,
  type ModuleCatalogCategory,
} from './module-catalog';
import {
  readModulePreferences,
  recordRecentModule,
  toggleModuleFavorite,
} from './module-preferences';

interface QuickInsertProps {
  anchor: { x: number; y: number };
  onClose: () => void;
  onCreate: (moduleType: CanvasModuleType) => boolean | void | Promise<boolean | void>;
}

export function QuickInsert({ anchor, onClose, onCreate }: QuickInsertProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModuleCatalogCategory>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [preferences, setPreferences] = useState(() => readModulePreferences());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activationInFlight = useRef(false);
  const definitions = useMemo(
    () => listFilteredModuleDefinitions(query, category, preferences),
    [category, preferences, query],
  );
  const activeDefinition = definitions[Math.min(activeIndex, Math.max(0, definitions.length - 1))];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [category, query]);

  const createModule = async (moduleType: CanvasModuleType) => {
    if (activationInFlight.current) return;
    activationInFlight.current = true;
    try {
      const created = await Promise.resolve(onCreate(moduleType));
      if (created === true) {
        setPreferences(recordRecentModule(moduleType));
        onClose();
      }
    } finally {
      activationInFlight.current = false;
    }
  };

  const activateCategory = (nextIndex: number, currentTarget: HTMLButtonElement) => {
    const normalizedIndex = (nextIndex + moduleCatalogCategories.length) % moduleCatalogCategories.length;
    const nextCategory = moduleCatalogCategories[normalizedIndex]!;
    setCategory(nextCategory.id);
    const tabs = currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[normalizedIndex]?.focus();
  };

  return (
    <section
      className="quick-insert"
      data-testid="quick-insert"
      aria-label="快速插入模块"
      style={{ left: anchor.x, top: anchor.y }}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        } else if (event.key === 'ArrowDown' && definitions.length > 0) {
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % definitions.length);
        } else if (event.key === 'ArrowUp' && definitions.length > 0) {
          event.preventDefault();
          setActiveIndex((index) => (index - 1 + definitions.length) % definitions.length);
        } else if (event.key === 'Enter' && activeDefinition) {
          event.preventDefault();
          void createModule(activeDefinition.type);
        }
      }}
    >
      <header className="quick-insert__header">
        <div>
          <strong>添加模块</strong>
          <span>Quick Insert</span>
        </div>
        <button className="icon-button" type="button" aria-label="关闭快速插入" title="关闭快速插入" onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <label className="quick-insert__search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          aria-label="搜索快速插入模块"
          placeholder="搜索模块或能力"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <CornerDownLeft size={13} aria-hidden="true" />
      </label>
      <span className="visually-hidden" role="status" aria-live="polite">
        {activeDefinition ? `当前模块 ${activeDefinition.primaryName}` : '没有匹配的模块'}
      </span>
      <div className="quick-insert__categories" role="tablist" aria-label="快速插入分类">
        {moduleCatalogCategories.map((item, index) => (
          <button
            key={item.id}
            id={`quick-insert-category-${item.id}`}
            type="button"
            role="tab"
            aria-controls="quick-insert-results"
            aria-selected={category === item.id}
            tabIndex={category === item.id ? 0 : -1}
            className={category === item.id ? 'is-active' : ''}
            onClick={() => setCategory(item.id)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                activateCategory(index + 1, event.currentTarget);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                activateCategory(index - 1, event.currentTarget);
              } else if (event.key === 'Home') {
                event.preventDefault();
                activateCategory(0, event.currentTarget);
              } else if (event.key === 'End') {
                event.preventDefault();
                activateCategory(moduleCatalogCategories.length - 1, event.currentTarget);
              }
            }}
          >
            {item.label.split(' / ')[0]}
          </button>
        ))}
      </div>
      <div
        id="quick-insert-results"
        className="quick-insert__results"
        role="tabpanel"
        aria-labelledby={`quick-insert-category-${category}`}
      >
        <div className="quick-insert__list" role="list" aria-label="可插入模块">
          {definitions.map((definition, index) => {
            const Icon = resolveCanvasModuleIcon(definition.type);
            const isActive = index === activeIndex;
            const isFavorite = preferences.favorites.includes(definition.type);
            return (
              <div
                key={definition.type}
                className={`quick-insert__row${isActive ? ' is-active' : ''}`}
                role="listitem"
              >
                <button
                  type="button"
                  className="quick-insert__module"
                  aria-label={`插入 ${definition.primaryName} / ${definition.secondaryName}`}
                  aria-current={isActive ? 'true' : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => { void createModule(definition.type); }}
                >
                  <span className="quick-insert__icon" data-icon-category={definition.category} aria-hidden="true">
                    <Icon size={17} strokeWidth={1.8} />
                  </span>
                  <span>
                    <strong>{definition.primaryName}</strong>
                    <small>{definition.secondaryName}</small>
                  </span>
                  {definition.type === 'image_generation' || definition.type === 'reverse_agent'
                    ? <b>推荐</b>
                    : null}
                </button>
                <button
                  type="button"
                  className="quick-insert__favorite"
                  aria-label={`${isFavorite ? '取消收藏' : '收藏'} ${definition.primaryName} / ${definition.secondaryName}`}
                  aria-pressed={isFavorite}
                  onClick={() => setPreferences(toggleModuleFavorite(definition.type))}
                >
                  <Star size={14} fill={isFavorite ? 'currentColor' : 'none'} />
                </button>
              </div>
            );
          })}
          {definitions.length === 0 && <div className="quick-insert__empty" role="status">没有匹配的模块</div>}
        </div>
      </div>
    </section>
  );
}
