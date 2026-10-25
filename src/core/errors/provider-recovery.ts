import { classifyError, FailoverReason } from './classification';

/** Reset dates emitted by subscription CLIs; retain the original message alongside this estimate. */
export function providerResetAt(message: string): Date | undefined {
  const text = message.match(/(?:try again at|resets? at)\s+(.+?)(?:\n|$)/i)?.[1];
  if (!text) return undefined;
  const at = Date.parse(text.replace(/(\d+)(st|nd|rd|th)\b/g, '$1').replace(/[.!]+$/, ''));
  return Number.isFinite(at) ? new Date(at) : undefined;
}

export function isProviderQuotaMessage(message: string): boolean {
  return /(?:hit|reached|exceeded).{0,20}(?:usage|subscription) limit|quota.{0,20}(?:exhaust|exceed)|insufficient.quota/i.test(message);
}

/** Infrastructure retries have their own small budget, independent of QA/rework attempts. */
export function providerRetryDelay(error: unknown, retry: number): number | null {
  const classified = classifyError(error);
  if (retry >= 3 || ![FailoverReason.RATE_LIMIT, FailoverReason.PROVIDER_DOWN, FailoverReason.NETWORK_TIMEOUT,
    FailoverReason.INVALID_RESPONSE].includes(classified.reason)) return null;
  return Math.min(30_000, Math.max(classified.retryAfterMs ?? 0, 1000 * 2 ** retry));
}
