import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAppStore } from '../app/app-store';
import { registerEditorDraft } from '../app/editor-draft-boundary';

// The preview is scoped to one mounted editor; execution always flushes that
// editor and reads the validated project, never this transient display value.
const previews = new Map<string, { owner: object; prompt: string }>();
const listeners = new Set<() => void>();
const previewKey = (projectId: string, nodeId: string) => JSON.stringify([projectId, nodeId]);
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };

export function useTextPromptPreview(projectId: string, sourceNodeId: string | undefined): string | undefined {
  const key = sourceNodeId === undefined ? undefined : previewKey(projectId, sourceNodeId);
  return useSyncExternalStore(subscribe, () => key === undefined ? undefined : previews.get(key)?.prompt);
}

export function TextPromptEditor({ id, projectId, prompt }: { id: string; projectId: string; prompt: string }) {
  const persist = useAppStore(state => state.draftTextPromptNodeConfig);
  const readOnly = useAppStore(state => state.saveStatus === 'read_only' || state.recoveryRequired || state.projectCommitConflictCode !== null);
  const [value, setValue] = useState(prompt);
  const [saveError, setSaveError] = useState(false);
  const latest = useRef(prompt);
  const dirty = useRef(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const owner = useRef({});
  const mounted = useRef(true);
  const key = previewKey(projectId, id);
  const flush = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (inFlight.current !== null) return inFlight.current;
    if (!dirty.current) return Promise.resolve(true);
    const task = (async () => {
      try {
        while (dirty.current) {
          const next = latest.current;
          if (!await persist(id, next, projectId)) {
            if (mounted.current) setSaveError(true);
            return false;
          }
          if (next === latest.current) dirty.current = false;
        }
        if (mounted.current) setSaveError(false);
        return true;
      } catch {
        if (mounted.current) setSaveError(true);
        return false;
      }
    })();
    inFlight.current = task;
    void task.then(() => { inFlight.current = null; });
    return task;
  }, [id, persist, projectId]);
  useEffect(() => registerEditorDraft(flush), [flush]);
  useEffect(() => {
    if (!dirty.current && inFlight.current === null) {
      latest.current = prompt;
      setValue(prompt);
      if (previews.get(key)?.owner === owner.current) { previews.delete(key); notify(); }
    }
  }, [key, prompt]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flush();
      if (previews.get(key)?.owner === owner.current) { previews.delete(key); notify(); }
    };
  }, [flush, key]);
  return <section className="module-node__summary module-node__text-prompt nodrag nopan" aria-label="提示词编辑" onPointerDown={event => event.stopPropagation()}>
    <label>提示词<textarea aria-label="Text prompt" rows={8} value={value} readOnly={readOnly}
      onChange={event => {
        latest.current = event.target.value;
        dirty.current = true;
        setValue(latest.current);
        previews.set(key, { owner: owner.current, prompt: latest.current });
        notify();
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { void flush(); }, 180);
      }} onBlur={() => { void flush(); }} /></label>
    <small>连接的生成节点使用这里的完整提示词。</small>
    {saveError && <p role="alert" aria-label="Prompt save error">提示词尚未保存，请重试。</p>}
  </section>;
}
