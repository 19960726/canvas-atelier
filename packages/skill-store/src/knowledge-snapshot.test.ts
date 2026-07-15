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

  it.each([
    buildAuthorizationHeader(),
    buildInlineImage(),
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

function buildAbsolutePath(): string {
  return ['C:', 'redacted', 'skill.md'].join('\\');
}
