import { defineConfig } from 'vitest/config';
import {
  desktopCoreTestProject,
  domainTestProject,
  providerComflyTestProject,
  rendererTestProject,
  skillStoreTestProject,
} from './vitest.workspace';

export default defineConfig({
  test: {
    projects: [domainTestProject, rendererTestProject, skillStoreTestProject, providerComflyTestProject, desktopCoreTestProject],
  },
});
