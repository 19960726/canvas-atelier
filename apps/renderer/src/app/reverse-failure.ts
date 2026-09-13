// Only finite, application-owned reasons cross the display/persistence boundary.
const REVERSE_FAILURE_MESSAGES = {
  TRUNCATED: '模型输出达到长度上限而被截断，请减少素材或缩短任务后重试。',
  NO_TEXT: '模型没有返回可用文本，请重试或更换反推模型。',
  INVALID_JSON: '模型返回的内容不是有效 JSON，请重试或更换反推模型。',
  CORE_SCHEMA_INVALID: '模型返回内容缺少反推必填字段，请重试或更换反推模型。',
  IDENTITY_MISMATCH: '模型返回结果不属于本次反推运行，已拒绝使用。',
  MEDIA_RESPONSIBILITIES_INVALID: '模型没有完整说明每个素材的职责，请重试或减少素材。',
} as const;

const NETWORK_FAILURE_MESSAGES = {
  ERR_CONNECTION_CLOSED: '模型服务连接被关闭（ERR_CONNECTION_CLOSED），本次没有取得可用回复。请检查代理或稍后重试。',
  ERR_CONNECTION_RESET: '模型服务连接被重置（ERR_CONNECTION_RESET），本次没有取得可用回复。请检查代理或稍后重试。',
  ERR_PROXY_CONNECTION_FAILED: '代理连接失败（ERR_PROXY_CONNECTION_FAILED），请检查代理设置后重试。',
  ERR_TUNNEL_CONNECTION_FAILED: '代理隧道连接失败（ERR_TUNNEL_CONNECTION_FAILED），请检查代理设置后重试。',
  ERR_NAME_NOT_RESOLVED: '无法解析模型服务地址（ERR_NAME_NOT_RESOLVED），请检查网络后重试。',
} as const;

export function readProviderNetworkFailure(error: unknown): keyof typeof NETWORK_FAILURE_MESSAGES | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error) || typeof error.message !== 'string') return undefined;
  const match = error.message.match(/\b(ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED)\b/u);
  return match?.[1] as keyof typeof NETWORK_FAILURE_MESSAGES | undefined;
}

export function readReverseFailureReason(error: unknown): keyof typeof REVERSE_FAILURE_MESSAGES | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'PROVIDER_INVALID_RESPONSE' || !('reason' in error)) return undefined;
  const reason = error.reason;
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(REVERSE_FAILURE_MESSAGES, reason)
    ? reason as keyof typeof REVERSE_FAILURE_MESSAGES : undefined;
}

export function reverseFailureMessage(error: unknown): string | undefined {
  const reason = readReverseFailureReason(error);
  if (reason !== undefined) return REVERSE_FAILURE_MESSAGES[reason];
  const network = readProviderNetworkFailure(error);
  return network === undefined ? undefined : NETWORK_FAILURE_MESSAGES[network];
}
