import type {
  AckImageJobTerminalBridgeRequest,
  AckImageJobTerminalBridgeResult,
  AckVideoJobTerminalBridgeRequest,
  AckVideoJobTerminalBridgeResult,
  AnalyzeReversePromptBridgeRequest,
  AnalyzeReversePromptBridgeResult,
  ChatSkillBridgeRequest,
  ChatSkillBridgeResult,
  GenerateStoryboardBridgeRequest,
  GenerateStoryboardBridgeResult,
  CancelImageJobBridgeRequest,
  CancelImageJobBridgeResult,
  CancelVideoJobBridgeRequest,
  CancelVideoJobBridgeResult,
  ConfigureProviderBridgeRequest,
  UpdateProviderProfilesBridgeRequest,
  PollImageJobBridgeRequest,
  PollImageJobBridgeResult,
  PollVideoJobBridgeRequest,
  PollVideoJobBridgeResult,
  ProviderBridgeProfile,
  ProviderActiveState,
  LoginRelayMeBridgeRequest,
  ProviderConfigurationStatus,
  ProviderConnectionCheckResult,
  RevealProviderCredentialBridgeResult,
  SubmitImageJobBridgeRequest,
  SubmitImageJobBridgeResult,
  SubmitVideoJobBridgeRequest,
  SubmitVideoJobBridgeResult,
  UnlockProviderBridgeRequest,
} from './provider-contracts.js';

export interface ProviderService {
  loginRelayMe?(request: LoginRelayMeBridgeRequest): Promise<void>;
  logoutRelayMe?(): Promise<void>;
  getStatus(): Promise<ProviderConfigurationStatus>;
  revealCredential(): Promise<RevealProviderCredentialBridgeResult>;
  checkConnection(): Promise<ProviderConnectionCheckResult>;
  configure(request: ConfigureProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  updateProfiles?(request: UpdateProviderProfilesBridgeRequest): Promise<ProviderConfigurationStatus>;
  unlock(request: UnlockProviderBridgeRequest): Promise<ProviderConfigurationStatus>;
  listAvailableModelIds(): Promise<string[]>;
  listProfiles(): Promise<ProviderBridgeProfile[]>;
  submitImageJob(request: SubmitImageJobBridgeRequest): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(request: PollImageJobBridgeRequest): Promise<PollImageJobBridgeResult>;
  cancelImageJob(request: CancelImageJobBridgeRequest): Promise<CancelImageJobBridgeResult>;
  ackImageJobTerminal(request: AckImageJobTerminalBridgeRequest): Promise<AckImageJobTerminalBridgeResult>;
  submitVideoJob?(request: SubmitVideoJobBridgeRequest): Promise<SubmitVideoJobBridgeResult>;
  pollVideoJob?(request: PollVideoJobBridgeRequest): Promise<PollVideoJobBridgeResult>;
  cancelVideoJob?(request: CancelVideoJobBridgeRequest): Promise<CancelVideoJobBridgeResult>;
  ackVideoJobTerminal?(request: AckVideoJobTerminalBridgeRequest): Promise<AckVideoJobTerminalBridgeResult>;
  analyzeReversePrompt?(request: AnalyzeReversePromptBridgeRequest): Promise<AnalyzeReversePromptBridgeResult>;
  chat?(request: ChatSkillBridgeRequest): Promise<ChatSkillBridgeResult>;
  generateStoryboard?(request: GenerateStoryboardBridgeRequest): Promise<GenerateStoryboardBridgeResult>;
}

export interface ProviderBridgeHandlers {
  getActiveProvider(event: unknown, request: unknown): Promise<ProviderActiveState>;
  setActiveProvider(event: unknown, request: unknown): Promise<ProviderActiveState>;
  loginRelayMe(event: unknown, request: unknown): Promise<ProviderActiveState>;
  logoutRelayMe(event: unknown, request: unknown): Promise<ProviderActiveState>;
  getStatus(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  revealCredential(event: unknown, request: unknown): Promise<RevealProviderCredentialBridgeResult>;
  checkConnection(event: unknown, request: unknown): Promise<ProviderConnectionCheckResult>;
  configure(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  updateProfiles(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  unlock(event: unknown, request: unknown): Promise<ProviderConfigurationStatus>;
  listAvailableModelIds(event: unknown, request: unknown): Promise<string[]>;
  listProfiles(event: unknown, request: unknown): Promise<ProviderBridgeProfile[]>;
  submitImageJob(event: unknown, request: unknown): Promise<SubmitImageJobBridgeResult>;
  pollImageJob(event: unknown, request: unknown): Promise<PollImageJobBridgeResult>;
  cancelImageJob(event: unknown, request: unknown): Promise<CancelImageJobBridgeResult>;
  ackImageJobTerminal(event: unknown, request: unknown): Promise<AckImageJobTerminalBridgeResult>;
  submitVideoJob(event: unknown, request: unknown): Promise<SubmitVideoJobBridgeResult>;
  pollVideoJob(event: unknown, request: unknown): Promise<PollVideoJobBridgeResult>;
  cancelVideoJob(event: unknown, request: unknown): Promise<CancelVideoJobBridgeResult>;
  ackVideoJobTerminal(event: unknown, request: unknown): Promise<AckVideoJobTerminalBridgeResult>;
  analyzeReversePrompt(event: unknown, request: unknown): Promise<AnalyzeReversePromptBridgeResult>;
  chat(event: unknown, request: unknown): Promise<ChatSkillBridgeResult>;
  generateStoryboard(event: unknown, request: unknown): Promise<GenerateStoryboardBridgeResult>;
}

export interface ProviderActiveStateStore {
  getActiveProvider(): Promise<ProviderActiveState>;
  setActiveProvider(activeProvider: ProviderActiveState['activeProvider']): Promise<ProviderActiveState>;
}

export interface ProviderIpcMainLike {
  handle(channel: string, listener: (event: unknown, request: unknown) => Promise<unknown>): void;
}
