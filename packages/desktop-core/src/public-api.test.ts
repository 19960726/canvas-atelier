import { expectTypeOf, test } from 'vitest';

import type {
  ChatSkillBridgeRequest,
  ChatSkillBridgeResult,
  DesktopProviderBridgeApi,
} from './index.js';

test('exports the public Skill Chat bridge types', () => {
  expectTypeOf<DesktopProviderBridgeApi['chat']>().toEqualTypeOf<(
    request: ChatSkillBridgeRequest,
  ) => Promise<ChatSkillBridgeResult>>();
});
