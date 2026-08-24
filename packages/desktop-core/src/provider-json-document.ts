const FENCED_JSON = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/iu;

export function parseProviderJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  const match = FENCED_JSON.exec(trimmed);
  const json = match?.[1] ?? trimmed;

  if (trimmed.startsWith('```') && match === null) {
    throw new Error('Provider must return a single JSON document');
  }

  try {
    return JSON.parse(json);
  } catch {
    throw new Error('Provider must return a single JSON document');
  }
}
