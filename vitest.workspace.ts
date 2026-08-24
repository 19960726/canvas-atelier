import { fileURLToPath } from 'node:url';

const sourceAliases = {
  '@agent-canvas/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
  '@agent-canvas/desktop-bridge/preload': fileURLToPath(new URL('./packages/desktop-bridge/src/preload.ts', import.meta.url)),
  '@agent-canvas/desktop-bridge': fileURLToPath(new URL('./packages/desktop-bridge/src/index.ts', import.meta.url)),
  '@agent-canvas/desktop-core/preload-api': fileURLToPath(new URL('./packages/desktop-core/src/preload-api.ts', import.meta.url)),
  '@agent-canvas/desktop-core': fileURLToPath(new URL('./packages/desktop-core/src/index.ts', import.meta.url)),
};

export const domainTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/domain',
    environment: 'node',
    include: ['packages/domain/src/**/*.test.ts'],
  },
};

export const rendererTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/renderer',
    environment: 'jsdom',
    include: ['apps/renderer/src/**/*.test.ts', 'apps/renderer/src/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    setupFiles: ['apps/renderer/src/test/setup.ts'],
  },
};

export const skillStoreTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/skill-store',
    environment: 'node',
    include: ['packages/skill-store/src/**/*.test.ts'],
  },
};

export const providerRelayMeTestProject = {
  resolve: { alias: sourceAliases },
  test: {
    name: '@agent-canvas/provider-relayme',
    environment: 'node',
    include: ['packages/provider-relayme/src/**/*.test.ts'],
  },
};

export const providerComflyTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/provider-comfly',
    environment: 'node',
    include: ['packages/provider-comfly/src/**/*.test.ts'],
  },
};

export const desktopCoreTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/desktop-core',
    environment: 'node',
    include: ['packages/desktop-core/src/**/*.test.ts'],
  },
};

export const desktopBridgeTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/desktop-bridge',
    environment: 'node',
    include: ['packages/desktop-bridge/src/**/*.test.ts'],
  },
};

export const desktopShellTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/desktop-shells',
    environment: 'node',
    include: ['apps/desktop-modern/src/**/*.test.ts', 'apps/desktop-legacy/src/**/*.test.ts'],
  },
};

export const mcpBridgeTestProject = {
  resolve: {
    alias: sourceAliases,
  },
  test: {
    name: '@agent-canvas/mcp-bridge',
    environment: 'node',
    include: ['packages/mcp-bridge/src/**/*.test.ts'],
  },
};