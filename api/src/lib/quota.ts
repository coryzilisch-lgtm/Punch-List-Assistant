/**
 * Procore's rate-limit quota, read off the responses rather than assumed.
 *
 * The 228-item Darden import ran straight into an empty quota twice: 147 items
 * landed, then every later item drew a 429, and a retry 40 minutes later found
 * the quota empty again. This app spends about 2 requests per item, so it was not
 * what drained it — the service account is shared with the Safety Dashboard
 * ingest. The app could not see any of that because it never read the headers
 * Procore sends on every response. It read `X-Rate-Limit-Reset` only after being
 * refused.
 *
 * Pure functions plus one module-level snapshot. The snapshot lives as long as
 * the warm Function instance; it is only ever used to REFUSE early, never to
 * permit something Procore would refuse, so a stale one costs at most one wasted
 * request after the reset passes.
 */

export interface QuotaSnapshot {
  /** `X-Rate-Limit-Limit`: requests allowed per window, when sent. */
  limit: number | null;
  /** `X-Rate-Limit-Remaining`: requests left in this window, when sent. */
  remaining: number | null;
  /** When the window resets, epoch ms, when `X-Rate-Limit-Reset` was usable. */
  resetAt: number | null;
  /** When this snapshot was read, epoch ms. */
  observedAt: number;
}

/**
 * Requests one pushed item costs, budgeted. Measured against a mocked Procore:
 * 2 when the photo lands on the create (create + read-back, the normal path), 6
 * when it does not and the PATCH fallbacks run. 3 covers the normal path with
 * room for the occasional fallback; a push of nothing but fallbacks will stop
 * early, which is the safe direction to be wrong in.
 */
export const REQUESTS_PER_ITEM = 3;

/**
 * Requests a push leaves untouched for everyone else on the service account —
 * the Safety Dashboard ingest above all. A push that spends the quota to zero
 * fails its own last items and starves the ingest.
 */
export const QUOTA_RESERVE = 200;

/** A header value as a non-negative number, or null. */
function num(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * `X-Rate-Limit-Reset` as epoch ms. It may be an epoch second or a number of
 * seconds from now — the same ambiguity `rateLimitWaitMs` handles: above ~1e9
 * is an epoch second (that threshold passed in 2001), below it is a duration.
 */
export function resetAtFromHeader(value: string | null, now: number): number | null {
  const n = num(value);
  if (n === null || n === 0) return null;
  return n > 1_000_000_000 ? n * 1000 : now + n * 1000;
}

/** Read the quota headers off a response. Null when Procore sent none of them. */
export function readQuota(headers: { get(name: string): string | null }, now: number): QuotaSnapshot | null {
  const limit = num(headers.get('X-Rate-Limit-Limit'));
  const remaining = num(headers.get('X-Rate-Limit-Remaining'));
  const resetAt = resetAtFromHeader(headers.get('X-Rate-Limit-Reset'), now);
  if (limit === null && remaining === null) return null;
  return { limit, remaining, resetAt, observedAt: now };
}

/**
 * How many more items fit in this window while leaving the reserve alone.
 * Null when that is unknown: no Remaining header, or a window that has already
 * reset, whose Remaining no longer describes anything.
 */
export function pushCapacity(q: QuotaSnapshot | null, now: number): number | null {
  if (!q || q.remaining === null) return null;
  if (q.resetAt !== null && q.resetAt <= now) return null;
  return Math.max(0, Math.floor((q.remaining - QUOTA_RESERVE) / REQUESTS_PER_ITEM));
}

let last: QuotaSnapshot | null = null;

/** Remember the newest snapshot. A response without quota headers changes nothing. */
export function recordQuota(q: QuotaSnapshot | null): void {
  if (q) last = q;
}

/** The newest snapshot, or null if none has been seen or its window has reset. */
export function currentQuota(now: number): QuotaSnapshot | null {
  if (!last) return null;
  if (last.resetAt !== null && last.resetAt <= now) return null;
  return last;
}

/**
 * The reset time, when Procore has said Remaining is 0 and that window has not
 * reset yet. Calling Procore then can only draw another 429, which spends nothing
 * useful and, on some limiters, extends the penalty.
 */
export function exhaustedUntil(now: number): number | null {
  const q = currentQuota(now);
  if (!q || q.remaining !== 0 || q.resetAt === null) return null;
  return q.resetAt;
}

/** Test seam: forget the snapshot. */
export function resetQuotaForTests(): void {
  last = null;
}

/** What the API reports to the dashboard. */
export function quotaReport(now: number) {
  const q = currentQuota(now);
  return {
    limit: q?.limit ?? null,
    remaining: q?.remaining ?? null,
    resetAt: q?.resetAt ?? null,
    capacity: pushCapacity(q, now),
    perItem: REQUESTS_PER_ITEM,
    reserve: QUOTA_RESERVE,
  };
}
