import { defineConfig } from 'vitest/config';
import { domainTestProject } from './vitest.workspace';

export default defineConfig({
  test: {
    projects: [domainTestProject],
  },
});
