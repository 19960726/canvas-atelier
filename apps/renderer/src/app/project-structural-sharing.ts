import type { CanvasProject } from '@agent-canvas/domain';

/** Reuse equal JSON DTO branches after validation; never change their values. */
export function reuseUnchangedProjectReferences(previous: CanvasProject, next: CanvasProject): CanvasProject {
  if (previous.id !== next.id) return next;
  return reuseValidatedValue(previous, next) as CanvasProject;
}

function reuseValidatedValue(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (Array.isArray(previous) && Array.isArray(next)) {
    let unchanged = previous.length === next.length;
    const shared = next.map((value, index) => {
      const result = reuseValidatedValue(previous[index], value);
      if (!Object.is(result, previous[index])) unchanged = false;
      return result;
    });
    return unchanged ? previous : shared;
  }
  if (!isPlainObject(previous) || !isPlainObject(next)) return next;
  const nextKeys = Object.keys(next);
  let unchanged = Object.keys(previous).length === nextKeys.length;
  const entries = nextKeys.map((key) => {
    const existed = Object.prototype.hasOwnProperty.call(previous, key);
    const result = reuseValidatedValue(existed ? previous[key] : undefined, next[key]);
    if (!existed || !Object.is(result, previous[key])) unchanged = false;
    return [key, result] as const;
  });
  return unchanged ? previous : Object.fromEntries(entries);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
