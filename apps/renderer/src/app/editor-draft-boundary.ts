type DraftFlush = () => void | boolean | Promise<void | boolean>;
const pendingEditors = new Set<DraftFlush>();

export function registerEditorDraft(flush: DraftFlush): () => void {
  pendingEditors.add(flush);
  return () => { pendingEditors.delete(flush); };
}

/** Commit component drafts before inspecting the project's durable-save state. */
export function flushEditorDrafts(): true | Promise<boolean> {
  if (pendingEditors.size === 0) return true;
  try {
    return Promise.all([...pendingEditors].map((flush) => flush()))
      .then((results) => results.every((result) => result !== false), () => false);
  } catch {
    return Promise.resolve(false);
  }
}
