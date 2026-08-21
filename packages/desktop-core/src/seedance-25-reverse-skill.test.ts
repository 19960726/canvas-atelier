import { describe, expect, it } from 'vitest';
import { getSeedance25ReverseSkill } from './seedance-25-reverse-skill';

describe('Seedance 2.5 reverse skill', () => {
  it('ships a versioned production reverse skill for canvas providers', () => {
    const skill = getSeedance25ReverseSkill();

    expect(skill).toMatchObject({
      id: 'seedance-2-5-reverse',
      version: '2026-08-21.1',
      source: 'https://mp.weixin.qq.com/s/Jv5iCILkg10q8o-KZ4GpNQ',
    });
    expect(skill.taskTypes).toContain('video_edit');
    expect(skill.taskTypes).toContain('multi_keyframe');
    expect(JSON.stringify(skill)).toMatch(/素材职责|阶段|结束状态|唯一母版|首帧|尾帧|白模|声音|时间戳|能力边界/u);
    expect(Object.isFrozen(skill)).toBe(true);
    expect(Object.isFrozen(skill.rules)).toBe(true);
  });

  it('returns the same immutable contract instead of mutable per-run copies', () => {
    expect(getSeedance25ReverseSkill()).toBe(getSeedance25ReverseSkill());
  });
});
