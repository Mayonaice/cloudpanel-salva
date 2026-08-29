export const DEFAULT_LEASE_SECONDS = 60;
export const MAX_LEASE_SECONDS = 300;
export const DEFAULT_BATCH_SIZE = 10;
export const MAX_BATCH_SIZE = 25;
export const MAX_JOB_ATTEMPTS = 8;

export function boundedBatchSize(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(value as number)));
}

export function boundedLeaseSeconds(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LEASE_SECONDS;
  return Math.min(MAX_LEASE_SECONDS, Math.max(1, Math.floor(value as number)));
}

export function retryDelayMs(attempt: number) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return 1_000;
  return Math.min(15 * 60 * 1_000, 2 ** Math.min(14, attempt - 1) * 1_000);
}
