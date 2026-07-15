import { describe, expect, it } from 'vitest';
import { createKnowledgeSnapshotCandidate } from './knowledge-snapshot';

describe('createKnowledgeSnapshotCandidate', () => {
  it('sorts managed documents canonically and computes stable hashes', () => {
    const input = {
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [
        { relativePath: 'skills/scene/SKILL.md', content: '# skill' },
        { relativePath: 'memory/main.md', content: '# memory' },
      ],
    };

    const first = createKnowledgeSnapshotCandidate(input);
    const second = createKnowledgeSnapshotCandidate({
      ...input,
      documents: [...input.documents].reverse(),
    });

    expect(first).toEqual(second);
    expect(first.documents.map((document) => document.relativePath)).toEqual([
      'memory/main.md',
      'skills/scene/SKILL.md',
    ]);
    expect(first.documents.every((document) => /^[a-f0-9]{64}$/.test(document.sha256))).toBe(true);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('uses locale-independent code-unit ordering for canonical hashing', () => {
    const candidate = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [
        { relativePath: 'memory/ä.md', content: '# a-umlaut' },
        { relativePath: 'memory/z.md', content: '# zed' },
        { relativePath: 'memory/a.md', content: '# alpha' },
      ],
    });

    expect(candidate.documents.map((document) => document.relativePath)).toEqual([
      'memory/a.md',
      'memory/z.md',
      'memory/ä.md',
    ]);
  });

  it.each([
    buildAuthorizationHeader(),
    buildInlineImage(),
    buildGenericDataUrl(),
    buildRawPngPayload(),
    buildRawJpegPayload(),
    buildRawGifPayload(),
    buildRawWebpPayload(),
    buildAbsolutePath(),
  ])('rejects protected content', (content) => {
    expect(() => createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content }],
    })).toThrow(/protected content/);
  });

  it('rejects managed paths that escape the selected knowledge root', () => {
    expect(() => createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: '../memory/main.md', content: '# memory' }],
    })).toThrow(/managed relative text document/);
  });

  it('rejects duplicate managed document paths after normalization', () => {
    expect(() => createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [
        { relativePath: 'memory/main.md', content: '# one' },
        { relativePath: 'memory\\main.md', content: '# two' },
      ],
    })).toThrow(/unique/);
  });

  it('accepts ordinary prose that happens to contain short base64-like words', () => {
    const candidate = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{
        relativePath: 'memory/main.md',
        content: 'Use words like canvas, alpha, token, and base64 in ordinary prose.',
      }],
    });

    expect(candidate.documents[0]?.content).toContain('ordinary prose');
  });

  it('accepts long hashes and opaque identifiers that are not embedded binary payloads', () => {
    const candidate = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{
        relativePath: 'memory/main.md',
        content: [
          'SHA256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          'Opaque ID 550e8400-e29b-41d4-a716-446655440000',
          'Token QWxwaGFOdW1lcmljSWRlbnRpZmllckZvclRlc3RpbmdPbmx5MTIzNDU2',
          'Technical prose about base64, image headers, and transport encodings.',
        ].join('\n'),
      }],
    });

    expect(candidate.documents[0]?.content).toContain('Opaque ID');
    expect(candidate.documents[0]?.content).toContain('Technical prose');
  });
});

function buildAuthorizationHeader(): string {
  return [['Auth', 'orization'].join(''), ': ', ['Bear', 'er'].join(''), ' redacted-token'].join('');
}

function buildInlineImage(): string {
  return [
    ['data', 'image'].join(':'),
    '/png;',
    ['base', '64'].join(''),
    ',',
    Buffer.from('image-bytes', 'utf8').toString('base64'),
  ].join('');
}

function buildGenericDataUrl(): string {
  return [
    'data:application/octet-stream;',
    ['base', '64'].join(''),
    ',',
    Buffer.from('binary-payload', 'utf8').toString('base64'),
  ].join('');
}

function buildRawPngPayload(): string {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0xkAAAAASUVORK5CYII=';
}

function buildRawJpegPayload(): string {
  return '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEBAVFRUVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fHR0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB6A//xAAXEAEBAQEAAAAAAAAAAAAAAAAAAREC/9oACAEBAAEFAjKf/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAwEBPwEf/8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAgEBPwEf/8QAGhAAAwADAQAAAAAAAAAAAAAAAQIRITHB8P/aAAgBAQAGPwJm1mM//8QAGxABAQACAwEAAAAAAAAAAAAAAQARITFBUWH/2gAIAQEAAT8hNZ1xuq4Tj6gI2x//2gAMAwEAAgADAAAAEB//xAAXEQEAAwAAAAAAAAAAAAAAAAABABEh/9oACAEDAQE/ECm//8QAFxEBAQEBAAAAAAAAAAAAAAAAAQARIf/aAAgBAgEBPxBXR//EAB0QAQACAQUBAAAAAAAAAAAAAAEAESExQVFhcfD/2gAIAQEAAT8Qp6d1lYuG8J0iNwQ6n2g07m4W8W//2Q==';
}

function buildRawGifPayload(): string {
  return 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
}

function buildRawWebpPayload(): string {
  return 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=';
}

function buildAbsolutePath(): string {
  return ['C:', 'redacted', 'skill.md'].join('\\');
}
