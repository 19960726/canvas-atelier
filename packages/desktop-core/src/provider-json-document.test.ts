import { describe, expect, it } from 'vitest';
import { parseProviderJsonDocument } from './provider-json-document';

describe('parseProviderJsonDocument', () => {
  it.each([
    ['{"analysis":"ok"}', { analysis: 'ok' }],
    ['```json\n{"analysis":"ok"}\n```', { analysis: 'ok' }],
    ['```\n{"analysis":"ok"}\n```', { analysis: 'ok' }],
  ])('parses one controlled JSON document', (text, expected) => {
    expect(parseProviderJsonDocument(text)).toEqual(expected);
  });

  it.each([
    'prefix {"analysis":"ok"}',
    '```json\n{"analysis":"ok"}\n``` trailing',
    '```json\n{"analysis":"ok"}\n```\n```json\n{}\n```',
  ])('rejects mixed or multiple documents', (text) => {
    expect(() => parseProviderJsonDocument(text)).toThrow(/single JSON document/i);
  });

  it('rejects native JSON followed by trailing text', () => {
    expect(() => parseProviderJsonDocument('{"analysis":"ok"} trailing text'))
      .toThrow(/single JSON document/i);
  });

  it.each([
    '```json\n{"analysis":"ok"}',
    '```json\n{"analysis":"ok"}\n``` trailing',
    '```json\n{"analysis":"ok"}\n``',
    '```json\n{"analysis":"ok"\n```',
  ])('rejects malformed or unterminated fenced JSON: %s', (text) => {
    expect(() => parseProviderJsonDocument(text)).toThrow(/single JSON document/i);
  });
});
