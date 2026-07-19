const MODEL_JOB_RUN_ID_PREFIX = 'model-job-v2-';

export function createModelJobRunId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${MODEL_JOB_RUN_ID_PREFIX}${nonce}`;
}
