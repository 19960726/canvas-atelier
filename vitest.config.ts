import { defineConfig } from 'vitest/config';
import {
  desktopCoreTestProject,
  desktopBridgeTestProject,
  domainTestProject,
  desktopShellTestProject,
  providerComflyTestProject,
  rendererTestProject,
  skillStoreTestProject,
} from './vitest.workspace';

export default defineConfig({
  test: {
    projects: [domainTestProject, rendererTestProject, skillStoreTestProject, providerComflyTestProject, desktopCoreTestProject, desktopBridgeTestProject, desktopShellTestProject],
  },
});
