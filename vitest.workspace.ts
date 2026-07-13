export const domainTestProject = {
  test: {
    name: '@agent-canvas/domain',
    environment: 'node',
    include: ['packages/domain/src/**/*.test.ts'],
  },
};

export const rendererTestProject = {
  test: {
    name: '@agent-canvas/renderer',
    environment: 'jsdom',
    include: ['apps/renderer/src/**/*.test.ts', 'apps/renderer/src/**/*.test.tsx'],
    setupFiles: ['apps/renderer/src/test/setup.ts'],
  },
};
