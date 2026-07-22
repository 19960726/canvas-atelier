import type {
  AckImageJobTerminalBridgeRequest,
  AckImageJobTerminalBridgeResult,
  CancelImageJobBridgeRequest,
  CancelImageJobBridgeResult,
  ConfigureProviderBridgeRequest,
  PollImageJobBridgeRequest,
  PollImageJobBridgeResult,
  ProviderBridgeProfile,
  ProviderConfigurationStatus,
  ProviderConnectionCheckResult,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  UnlockProviderBridgeRequest,
} from './provider-contracts.js';

export interface ProviderService {
  getStatus(): Promise<ProviderConfigurationStatus>;
  checkConnection(): Promise<ProviderConnectionCheckResult>;
  configure(request: ConfigureProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  unlock(request: UnlockProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  listProfiles(): Promise<ProviderBridgeProfile[]>;
  submitImageJob(request: SubmitImageJobBridgeRequest): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(request: PollImageJobBridgeRequest): Promise<PollImageJobBridgeResult>;
  cancelImageJob(request: CancelImageJobBridgeRequest): Promise<CancelImageJobBridgeResult>;
  ackImageJobTerminal(request: AckImageJobTerminalBridgeRequest): Promise<AckImageJobTerminalBridgeResult>;
}

export interface ProviderBridgeHandlers {
  getStatus(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  checkConnection(event: unknown, request: unknown): Promise<ProviderConnectionCheckResult>;
  configure(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  unlock(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  listProfiles(event: unknown, request: unknown): Promise<ProviderBridgeProfile[]>;
  submitImageJob(event: unknown, request: unknown): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(event: unknown, request: unknown): Promise<PollImageJobBridgeResult>;
  cancelImageJob(event: unknown, request: unknown): Promise<CancelImageJobBridgeResult>;
  ackImageJobTerminal(event: unknown, request: unknown): Promise<AckImageJobTerminalBridgeResult>;
}

export interface ProviderIpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => Promise<unknown>): void;
}
