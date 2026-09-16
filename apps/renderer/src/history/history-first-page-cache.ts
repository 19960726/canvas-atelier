import type {
  DesktopGenerationHistoryBridgeApi,
  ListGenerationHistoryBridgeRequest,
  ListGenerationHistoryBridgeResult,
} from '@agent-canvas/desktop-core';

export const DEFAULT_HISTORY_FIRST_PAGE_REQUEST = Object.freeze({
  pageSize: 30,
  sort: 'newest' as const,
  filters: Object.freeze({
    kind: 'all' as const,
    availability: 'all' as const,
    referenceState: 'all' as const,
    trashState: 'active' as const,
  }),
});

let cached: {
  readonly bridge: DesktopGenerationHistoryBridgeApi;
  readonly result: ListGenerationHistoryBridgeResult;
} | null = null;
let inFlight: {
  readonly bridge: DesktopGenerationHistoryBridgeApi;
  readonly promise: Promise<ListGenerationHistoryBridgeResult | null>;
} | null = null;

export function readGenerationHistoryFirstPage(
  bridge: DesktopGenerationHistoryBridgeApi | undefined,
): ListGenerationHistoryBridgeResult | null {
  return bridge !== undefined && cached?.bridge === bridge ? cached.result : null;
}

export function rememberGenerationHistoryFirstPage(
  bridge: DesktopGenerationHistoryBridgeApi,
  request: ListGenerationHistoryBridgeRequest,
  result: ListGenerationHistoryBridgeResult,
): void {
  if (!isDefaultFirstPageRequest(request)) return;
  cached = { bridge, result };
}

export function preloadGenerationHistoryFirstPage(): Promise<ListGenerationHistoryBridgeResult | null> {
  const bridge = window.novusDesktop?.history;
  if (typeof bridge?.list !== 'function') return Promise.resolve(null);
  if (cached?.bridge === bridge) return Promise.resolve(cached.result);
  if (inFlight?.bridge === bridge) return inFlight.promise;
  const promise = bridge.list(DEFAULT_HISTORY_FIRST_PAGE_REQUEST)
    .then((result) => {
      cached = { bridge, result };
      return result;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { bridge, promise };
  return promise;
}

export function resetGenerationHistoryFirstPageCacheForTests(): void {
  cached = null;
  inFlight = null;
}

function isDefaultFirstPageRequest(request: ListGenerationHistoryBridgeRequest): boolean {
  return request.cursor === undefined
    && request.pageSize === DEFAULT_HISTORY_FIRST_PAGE_REQUEST.pageSize
    && request.sort === DEFAULT_HISTORY_FIRST_PAGE_REQUEST.sort
    && request.filters.kind === DEFAULT_HISTORY_FIRST_PAGE_REQUEST.filters.kind
    && request.filters.availability === DEFAULT_HISTORY_FIRST_PAGE_REQUEST.filters.availability
    && request.filters.referenceState === DEFAULT_HISTORY_FIRST_PAGE_REQUEST.filters.referenceState
    && request.filters.trashState === DEFAULT_HISTORY_FIRST_PAGE_REQUEST.filters.trashState
    && request.filters.projectId === undefined
    && request.filters.modelDisplayName === undefined
    && request.filters.statuses === undefined
    && request.filters.favorite === undefined
    && request.filters.text === undefined;
}
