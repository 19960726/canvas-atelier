import { useMemo, useState } from 'react';
import {
  Search,
  X,
} from 'lucide-react';
import {
  listCanvasModuleDefinitions,
  type CanvasModuleDefinition,
  type CanvasModuleType,
} from '@agent-canvas/domain';
import { resolveCanvasModuleIcon } from './module-icons';

export const MODULE_DRAG_MIME = 'application/x-novus-module';

const categories: Array<{ id: 'all' | CanvasModuleDefinition['category']; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'input', label: 'Input' },
  { id: 'generation', label: 'Generation' },
  { id: 'editing', label: 'Editing' },
  { id: 'analysis', label: 'Analysis' },
  { id: 'output', label: 'Output' },
];

export function writeModuleDragPayload(
  event: React.DragEvent,
  type: CanvasModuleType,
): void {
  event.dataTransfer.setData(MODULE_DRAG_MIME, type);
  event.dataTransfer.effectAllowed = 'copy';
}

function activateModule(
  event: React.KeyboardEvent<HTMLButtonElement>,
  moduleType: CanvasModuleType,
  onCreate: (moduleType: CanvasModuleType) => void,
): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onCreate(moduleType);
}

interface ModuleLibraryProps {
  onCreate: (moduleType: CanvasModuleType) => void;
  onClose?: () => void;
}

export function ModuleLibrary({ onCreate, onClose }: ModuleLibraryProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | CanvasModuleDefinition['category']>('all');
  const definitions = useMemo(() => listCanvasModuleDefinitions(), []);
  const filteredDefinitions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return definitions.filter((definition) => {
      if (category !== 'all' && definition.category !== category) return false;
      if (normalizedQuery.length === 0) return true;
      return [definition.displayName, ...definition.searchAliases]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    });
  }, [category, definitions, query]);

  return (
    <aside className="module-library" aria-label="Module library" data-testid="module-library">
      <header className="module-library__header">
        <div>
          <strong>Modules</strong>
          <span>{filteredDefinitions.length} available</span>
        </div>
        {onClose && (
          <button className="icon-button" type="button" aria-label="Close module library" title="Close module library" onClick={onClose}>
            <X size={15} />
          </button>
        )}
      </header>
      <label className="module-library__search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search modules"
          placeholder="Search modules"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="module-library__categories" role="tablist" aria-label="Module categories">
        {categories.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={category === item.id}
            className={category === item.id ? 'is-active' : ''}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="module-library__list">
        {filteredDefinitions.map((definition) => {
          const Icon = resolveCanvasModuleIcon(definition.iconKey);
          return (
            <button
              key={definition.type}
              type="button"
              className="module-library__item"
              aria-label={`Add ${definition.displayName}`}
              draggable
              onClick={() => onCreate(definition.type)}
              onKeyDown={(event) => activateModule(event, definition.type, onCreate)}
              onDragStart={(event) => writeModuleDragPayload(event, definition.type)}
            >
              <span className="module-library__item-icon" aria-hidden="true"><Icon size={15} /></span>
              <span className="module-library__item-copy">
                <strong>{definition.displayName}</strong>
                <small>{definition.category}</small>
              </span>
            </button>
          );
        })}
        {filteredDefinitions.length === 0 && (
          <div className="module-library__empty" role="status">No matching modules</div>
        )}
      </div>
    </aside>
  );
}
