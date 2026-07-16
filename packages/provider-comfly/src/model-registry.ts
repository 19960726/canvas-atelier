import type { ComflyMergedModelRegistration, ComflyModelCapability, ComflyModelRegistration } from './types';

export function mergeComflyModelRegistries(options: {
  readonly providerModels: readonly ComflyModelRegistration[];
  readonly profileModels: readonly ComflyModelRegistration[];
}): ComflyMergedModelRegistration[] {
  const registrations = new Map<string, {
    provider: string;
    modelRoute: string;
    displayName: string;
    modelId?: string;
    capabilities: Set<ComflyModelCapability>;
    hasProvider: boolean;
    hasProfile: boolean;
  }>();

  for (const model of options.providerModels) {
    upsertModel(registrations, model, 'provider');
  }
  for (const model of options.profileModels) {
    upsertModel(registrations, model, 'profile');
  }

  return [...registrations.entries()]
    .map(([, value]) => {
      const source: ComflyMergedModelRegistration['source'] = value.hasProvider && value.hasProfile
        ? 'merged'
        : value.hasProvider
          ? 'provider'
          : 'profile';
      return {
        provider: value.provider,
        modelRoute: value.modelRoute,
        displayName: value.displayName,
        ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
        capabilities: [...value.capabilities].sort(),
        source,
      };
    })
    .sort((left, right) => {
      const providerOrder = left.provider.localeCompare(right.provider);
      if (providerOrder !== 0) {
        return providerOrder;
      }
      return left.modelRoute.localeCompare(right.modelRoute);
    });
}

function upsertModel(
  registrations: Map<string, {
    provider: string;
    modelRoute: string;
    displayName: string;
    modelId?: string;
    capabilities: Set<ComflyModelCapability>;
    hasProvider: boolean;
    hasProfile: boolean;
  }>,
  model: ComflyModelRegistration,
  source: 'provider' | 'profile',
) {
  const key = `${model.provider}::${model.modelRoute}`;
  const current = registrations.get(key) ?? {
    provider: model.provider,
    modelRoute: model.modelRoute,
    displayName: model.displayName,
    modelId: model.modelId,
    capabilities: new Set<ComflyModelCapability>(),
    hasProvider: false,
    hasProfile: false,
  };
  for (const capability of model.capabilities) {
    current.capabilities.add(capability);
  }
  if (source === 'provider') {
    current.hasProvider = true;
    current.modelId = model.modelId ?? current.modelId;
  } else {
    current.hasProfile = true;
    current.modelId = model.modelId ?? current.modelId;
    current.displayName = model.displayName;
  }
  registrations.set(key, current);
}
