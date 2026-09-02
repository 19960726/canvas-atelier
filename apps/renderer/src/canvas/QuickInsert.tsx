import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Grid3X3, History, Search, Star, Upload, X } from 'lucide-react';
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
  compatibleModuleTypes?: readonly CanvasModuleType[];
  onClose: () => void;
  onCreate: (moduleType: CanvasModuleType) => boolean | void | Promise<boolean | void>;
  onImportImage?: (file: File) => boolean | void | Promise<boolean | void>;
  onOpenHistory?: () => void;
  onOpenLibrary?: () => void;
}

export function QuickInsert({ anchor, compatibleModuleTypes, onClose, onCreate, onImportImage, onOpenHistory, onOpenLibrary }: QuickInsertProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ModuleCatalogCategory>('all');
  const [activeIndex, setActiveIndex] = useState(0);
  const [preferences, setPreferences] = useState(() => readModulePreferences());
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const activationInFlight = useRef(false);
  const definitions = useMemo(() => {
    const allDefinitions = listFilteredModuleDefinitions(query, category, preferences);
    if (compatibleModuleTypes === undefined) return allDefinitions;
    const compatible = new Set(compatibleModuleTypes);
    return allDefinitions.filter((definition) => compatible.has(definition.type));
  }, [category, compatibleModuleTypes, preferences, query]);
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
      const creation = onCreate(moduleType);
      // A synchronous `false` is the only signal that the request was not
      // accepted. Once accepted, release the popover immediately instead of
      // holding its activation lock until desktop persistence finishes. That
      // lets a second node be inserted while the first durable save is queued.
      if (creation !== false) {
        onClose();
        const created = await Promise.resolve(creation);
        if (created !== false) {
          setPreferences(recordRecentModule(moduleType));
        }
      }
    } catch {
      // Creation and persistence failures are surfaced by the workspace save
      // status. The transient menu must not become an unhandled rejection
      // source after it has already closed.
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
      data-canvas-density="compact"
      data-canvas-surface="quick-insert"
      data-figma-density="compact"
      data-figma-surface="quick-insert"
      aria-label="快速插入模块"
      style={{ left: anchor.x, top: anchor.y }}
      onPointerDownCapture={(event) => event.stopPropagation()}
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
      <div className="quick-insert__figma-kicker">
        {compatibleModuleTypes === undefined ? '双击空白处 · 快速添加画布节点' : '连接到空白处 · 选择兼容节点'}
      </div>
      <header className="quick-insert__header">
        <div>
          <strong>添加节点</strong>
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
                data-module-type={definition.type}
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
        <section className="quick-insert__resources" aria-label="添加资源">
          <span className="quick-insert__resources-title">添加资源</span>
          <button type="button" className="quick-insert__resource" onClick={() => uploadInputRef.current?.click()}>
            <Upload size={15} aria-hidden="true" />
            <span>上传图片</span>
          </button>
          <button type="button" className="quick-insert__resource" onClick={() => { onClose(); onOpenHistory?.(); }}>
            <History size={15} aria-hidden="true" />
            <span>从生图历史选择</span>
          </button>
          <button type="button" className="quick-insert__resource" onClick={() => { onClose(); onOpenLibrary?.(); }}>
            <Grid3X3 size={15} aria-hidden="true" />
            <span>素材库</span>
            <b>NEW</b>
          </button>
          <input
            ref={uploadInputRef}
            className="quick-insert__upload-input"
            type="file"
            accept="image/*"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) {
                void Promise.resolve(onImportImage?.(file)).then(() => onClose());
              }
            }}
          />
        </section>
      </div>
      <footer className="quick-insert__figma-footer"><kbd>Esc</kbd><span>关闭</span><span>点击画布可创建节点</span></footer>
    </section>
  );
}
