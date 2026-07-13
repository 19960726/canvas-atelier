import { defineConfig } from 'vitest/config';
import { domainTestProject, rendererTestProject, skillStoreTestProject } from './vitest.workspace';

export default defineConfig({
  test: {
    projects: [domainTestProject, rendererTestProject, skillStoreTestProject],
  },
});
