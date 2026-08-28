import { parseReversePromptResult, type ReversePromptResult, type ReversePromptRun } from '@agent-canvas/domain';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  parseProviderBridgeResponse,
  type AnalyzeReversePromptBridgeResult,
} from './provider-contracts.js';
import { parseProviderJsonDocument } from './provider-json-document.js';
import { normalizeReverseProviderResult } from './reverse-provider-result.js';

export function parseReverseProviderResponse(
  response: { readonly text: string | undefined; readonly finishReason?: string },
  run: ReversePromptRun,
): ReversePromptResult {
  if (isTruncatedFinishReason(response.finishReason)) {
    throw createProviderBridgeError(
      'PROVIDER_INVALID_RESPONSE',
      'Reverse-analysis response was truncated at the model output limit',
      true,
      'TRUNCATED',
    );
  }
  if (response.text === undefined) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Reverse-analysis response did not contain text', false, 'NO_TEXT');
  }

  let providerDocument: unknown;
  try {
    providerDocument = parseProviderJsonDocument(response.text);
  } catch {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Reverse-analysis response was not valid JSON', true, 'INVALID_JSON');
  }

  let parsed: AnalyzeReversePromptBridgeResult;
  try {
    parsed = parseProviderBridgeResponse(
      PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt,
      normalizeReverseProviderResult(providerDocument, run),
    ) as AnalyzeReversePromptBridgeResult;
  } catch {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Reverse-analysis response failed schema validation', true, 'CORE_SCHEMA_INVALID');
  }

  try {
    return parseReversePromptResult(parsed, run);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/运行身份不匹配/u.test(message)) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Reverse-analysis response identity does not match the active run', false, 'IDENTITY_MISMATCH');
    }
    if (/素材职责/u.test(message)) {
      throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Reverse-analysis response has incomplete media responsibilities', true, 'MEDIA_RESPONSIBILITIES_INVALID');
    }
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Reverse-analysis response failed domain validation', true);
  }
}

function isTruncatedFinishReason(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toUpperCase().replace(/[-\s]+/gu, '_');
  return normalized === 'LENGTH' || normalized === 'MAX_TOKENS' || normalized === 'MAX_OUTPUT_TOKENS';
}
