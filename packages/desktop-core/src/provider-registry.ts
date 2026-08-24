import { createProviderBridgeError, ProviderIdSchema, type ProviderBridgeProvider } from './provider-contracts.js';
import type { ProviderService } from './provider-service-types.js';

export interface ProviderRegistry {
  get(provider: ProviderBridgeProvider): ProviderService;
}

export function createProviderRegistry(services: Readonly<Record<ProviderBridgeProvider, ProviderService>>): ProviderRegistry {
  return {
    get(provider) {
      const parsed = ProviderIdSchema.safeParse(provider);
      if (!parsed.success) throw createProviderBridgeError('INVALID_REQUEST', '未知的模型供应商');
      const service = services[parsed.data];
      if (service === undefined) throw createProviderBridgeError('PROVIDER_UNAVAILABLE', '模型供应商暂不可用');
      return service;
    },
  };
}

export function isProviderRegistry(value: ProviderService | ProviderRegistry): value is ProviderRegistry {
  return typeof (value as ProviderRegistry).get === 'function';
}