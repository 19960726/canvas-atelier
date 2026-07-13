import { defineConfig } from 'vitest/config';
import { domainTestProject, rendererTestProject } from './vitest.workspace';

export default defineConfig({
  test: {
    projects: [domainTestProject, rendererTestProject],
  },
});
