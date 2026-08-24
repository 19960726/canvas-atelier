import { defineConfig } from 'vitest/config';
import {
  desktopCoreTestProject,
  desktopBridgeTestProject,
  domainTestProject,
  desktopShellTestProject,
  providerComflyTestProject,
  providerRelayMeTestProject,
  rendererTestProject,
  skillStoreTestProject,
  mcpBridgeTestProject,
} from './vitest.workspace';

export default defineConfig({
  test: {
    maxWorkers: 2,
    projects: [domainTestProject, rendererTestProject, skillStoreTestProject, providerComflyTestProject, providerRelayMeTestProject, desktopCoreTestProject, desktopBridgeTestProject, desktopShellTestProject, mcpBridgeTestProject],
  },
});
