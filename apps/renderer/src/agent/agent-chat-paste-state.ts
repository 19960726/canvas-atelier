export type PasteReference = {
  readonly assetId: string;
  readonly label: string;
  readonly kind: 'image' | 'video';
  readonly mentionPosition: number;
};

export type PasteCitation = {
  readonly assetId: string;
  readonly label: string;
};

export type PasteComposer = {
  readonly text: string;
  readonly citations: PasteCitation[];
};

export type PasteImportKind = 'manual' | 'pasted';

export type PasteImportState = {
  readonly generation: number;
  readonly imports: readonly { readonly token: string; readonly generation: number; readonly kind: PasteImportKind }[];
};

export function reducePasteComposer(
  current: PasteComposer,
  text: string,
  references: readonly PasteReference[],
): PasteComposer {
  const referencesByAssetId = new Map(references.map((reference) => [reference.assetId, reference]));
  return {
    text,
    citations: current.citations.flatMap((citation) => {
      const reference = referencesByAssetId.get(citation.assetId);
      if (reference === undefined || !hasCompleteMentionToken(text, pasteMentionToken(reference))) return [];
      return [{ assetId: reference.assetId, label: reference.label }];
    }),
  };
}

export function attachPastedReference(
  current: PasteComposer,
  reference: PasteReference,
  marker: string | undefined,
  references: readonly PasteReference[],
): PasteComposer {
  const position = current.citations.findIndex((citation) => citation.assetId === reference.assetId);
  const text = marker === undefined && position >= 0
    ? current.text
    : insertPasteMentionAtMarker(current.text, pasteMentionToken(reference), marker);
  const citations = position < 0
    ? [...current.citations, { assetId: reference.assetId, label: reference.label }]
    : current.citations.map((citation, index) => index === position ? { assetId: reference.assetId, label: reference.label } : citation);
  return reducePasteComposer({ text, citations }, text, references);
}

export function resolveSelectedPasteReferences(
  citations: readonly PasteCitation[],
  references: readonly PasteReference[],
): { readonly assetId: string; readonly label: string; readonly mention: string }[] {
  const referencesByAssetId = new Map(references.map((reference) => [reference.assetId, reference]));
  const selected = new Set<string>();
  return citations.flatMap((citation) => {
    const reference = referencesByAssetId.get(citation.assetId);
    if (reference === undefined || selected.has(reference.assetId)) return [];
    selected.add(reference.assetId);
    return [{ assetId: reference.assetId, label: reference.label, mention: pasteMentionToken(reference) }];
  }).slice(0, 20);
}

export function upsertPasteReferenceByAssetId<T extends { readonly assetId: string }>(
  references: readonly T[],
  imported: T,
): T[] {
  const position = references.findIndex((reference) => reference.assetId === imported.assetId);
  return position < 0
    ? [...references, imported]
    : references.map((reference, index) => index === position ? imported : reference);
}

export function stripPendingPasteMarkers(text: string, markers: Iterable<string>): string {
  let clean = text;
  for (const marker of markers) clean = clean.split(marker).join('');
  return clean.replace(/[\u2063\u2064\u200B\u200C]/gu, '');
}

export function hasSendablePasteText(text: string, markers: Iterable<string>): boolean {
  return stripPendingPasteMarkers(text, markers).trim().length > 0;
}

export function createPasteImportState(): PasteImportState {
  return { generation: 0, imports: [] };
}

export function startPasteImport(
  state: PasteImportState,
  input: { readonly token: string; readonly kind: PasteImportKind },
): PasteImportState {
  return {
    ...state,
    imports: [...state.imports.filter((entry) => entry.token !== input.token), { ...input, generation: state.generation }],
  };
}

export function finishPasteImport(state: PasteImportState, token: string): PasteImportState {
  return { ...state, imports: state.imports.filter((entry) => entry.token !== token) };
}

export function invalidatePasteImportState(state: PasteImportState): PasteImportState {
  return { ...state, generation: state.generation + 1 };
}

export function isPasteGenerationCurrent(state: PasteImportState, generation: number): boolean {
  return state.generation === generation;
}

export function isPasteImportBusy(state: PasteImportState): boolean {
  return state.imports.some((entry) => entry.generation === state.generation);
}

export function pasteMentionToken(reference: Pick<PasteReference, 'kind' | 'mentionPosition'>): string {
  return `@${reference.kind === 'image' ? '图片' : '视频'}${reference.mentionPosition + 1}`;
}

function hasCompleteMentionToken(text: string, token: string): boolean {
  return new RegExp(`${escapeRegExp(token)}(?!\\d)`, 'u').test(text);
}

function insertPasteMentionAtMarker(text: string, mentionToken: string, marker: string | undefined): string {
  if (marker === undefined) return text.trimEnd().length === 0 ? mentionToken : `${text.trimEnd()} ${mentionToken}`;
  const markerPosition = text.indexOf(marker);
  if (markerPosition < 0) return text.trimEnd().length === 0 ? mentionToken : `${text.trimEnd()} ${mentionToken}`;
  const before = text.slice(0, markerPosition);
  const after = text.slice(markerPosition + marker.length);
  const leadingSpace = before.length > 0 && !/\s$/u.test(before) ? ' ' : '';
  const trailingSpace = after.length > 0 && !/^\s/u.test(after) ? ' ' : '';
  return `${before}${leadingSpace}${mentionToken}${trailingSpace}${marker}${after}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
