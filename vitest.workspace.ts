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
    include: ['apps/renderer/src/**/*.test.ts', 'apps/renderer/src/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    setupFiles: ['apps/renderer/src/test/setup.ts'],
  },
};

export const skillStoreTestProject = {
  test: {
    name: '@agent-canvas/skill-store',
    environment: 'node',
    include: ['packages/skill-store/src/**/*.test.ts'],
  },
};

export const providerComflyTestProject = {
  test: {
    name: '@agent-canvas/provider-comfly',
    environment: 'node',
    include: ['packages/provider-comfly/src/**/*.test.ts'],
  },
};

export const desktopCoreTestProject = {
  test: {
    name: '@agent-canvas/desktop-core',
    environment: 'node',
    include: ['packages/desktop-core/src/**/*.test.ts'],
  },
};

export const desktopBridgeTestProject = {
  test: {
    name: '@agent-canvas/desktop-bridge',
    environment: 'node',
    include: ['packages/desktop-bridge/src/**/*.test.ts'],
  },
};
