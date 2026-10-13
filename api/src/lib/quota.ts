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
 * The most a push leaves untouched for everyone else on the service account —
 * the Safety Dashboard ingest above all. A push that spends the quota to zero
 * fails its own last items and starves the ingest.
 *
 * ⚠️ A CAP, scaled by `reserveFor()`, never a fixed number. The first version
 * reserved a flat 200, sized for the ~3,600/hour quota everyone assumed these
 * headers describe. The tenant answered `X-Rate-Limit-Limit: 25` — a short
 * window — so 200 was eight windows' worth, capacity was always 0, and the app
 * refused to push anything at all (2026-10-13).
 */
export const QUOTA_RESERVE = 200;

/**
 * The longest a rate-limit reset is worth simply waiting out inside one
 * Function invocation. SWA kills Functions at 45 seconds.
 */
export const WAIT_IN_FUNCTION_MS = 5_000;

/** The reserve for the window Procore reported: a tenth of it, capped. */
export function reserveFor(q: QuotaSnapshot | null): number {
  if (!q || q.limit === null) return QUOTA_RESERVE;
  return Math.min(QUOTA_RESERVE, Math.floor(q.limit / 10));
}

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
  return Math.max(0, Math.floor((q.remaining - reserveFor(q)) / REQUESTS_PER_ITEM));
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

// ── Which limit is it? ───────────────────────────────────────────────────────
//
// Procore has a short burst window and a long (hourly-scale) quota. A third-party
// integrator's notes say the headers report the burst window whenever one
// applies, so the long quota may never appear in them at all; it shows up only
// as a 429 whose reset is minutes away. That is a lead, not a tenant answer. So
// this keeps the raw evidence instead of a conclusion: the rate headers exactly
// as Procore sent them, and every recent 429 with how far out it reset.

/** A reset further out than this belongs to the long quota, not the burst window. */
export const SHORT_WINDOW_MS = 90_000;

export type LimitWindow = 'short' | 'long';

export function windowOf(resetAt: number | null, now: number): LimitWindow | null {
  if (resetAt === null) return null;
  return resetAt - now <= SHORT_WINDOW_MS ? 'short' : 'long';
}

interface HeaderSighting {
  at: number;
  path: string;
  status: number;
  /** Every response header whose name mentions rate, limit or retry, verbatim. */
  headers: Record<string, string>;
}

interface LimitHit {
  at: number;
  path: string;
  resetAt: number;
  window: LimitWindow;
  headers: Record<string, string>;
}

let lastHeaders: HeaderSighting | null = null;
const limitHits: LimitHit[] = [];
const MAX_LIMIT_HITS = 20;
/** This instance's requests over the last hour, with the status each drew (null: no response). */
const requestLog: Array<{ at: number; status: number | null }> = [];
const instanceStartedAt = Date.now();
const HOUR_MS = 60 * 60 * 1000;

/** The rate-related headers of a response, verbatim, names lowercased. */
export function rateHeaders(headers: { forEach?(cb: (value: string, name: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach?.((value, name) => {
    if (/rate|limit|retry/i.test(name)) out[name.toLowerCase()] = value;
  });
  return out;
}

/** Count one request to Procore from this instance. */
export function noteRequest(now: number): void {
  requestLog.push({ at: now, status: null });
  while (requestLog.length && requestLog[0].at <= now - HOUR_MS) requestLog.shift();
}

/** Record the status the newest request drew. */
export function noteStatus(status: number): void {
  const lastEntry = requestLog[requestLog.length - 1];
  if (lastEntry && lastEntry.status === null) lastEntry.status = status;
}

/**
 * The last hour's requests by outcome. Procore counts failures exactly like
 * successes, so a 404 or a 429 spends the same quota as a create.
 */
function outcomes(now: number) {
  const recent = requestLog.filter((r) => r.at > now - HOUR_MS);
  const count = (test: (s: number | null) => boolean) => recent.filter((r) => test(r.status)).length;
  return {
    total: recent.length,
    ok: count((s) => s !== null && s < 400),
    rateLimited: count((s) => s === 429),
    clientErrors: count((s) => s !== null && s >= 400 && s < 500 && s !== 429),
    serverErrors: count((s) => s !== null && s >= 500),
    noResponse: count((s) => s === null),
  };
}

/** Remember the rate headers of the newest response that carried any. */
export function noteHeaders(path: string, status: number, headers: Record<string, string>, now: number): void {
  if (Object.keys(headers).length) lastHeaders = { at: now, path, status, headers };
}

/** Remember a 429, classed by how far out it resets. */
export function noteLimitHit(path: string, resetAt: number, headers: Record<string, string>, now: number): void {
  const window = windowOf(resetAt, now) ?? 'long';
  limitHits.push({ at: now, path, resetAt, window, headers });
  if (limitHits.length > MAX_LIMIT_HITS) limitHits.shift();
}

/** Test seam: forget everything. */
export function resetQuotaForTests(): void {
  last = null;
  lastHeaders = null;
  limitHits.length = 0;
  requestLog.length = 0;
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
    reserve: reserveFor(q),
    /** Which limit the headers above describe, judged by how soon they reset. */
    window: windowOf(q?.resetAt ?? null, now),
    /** The raw evidence. Open /api/quota in a browser to read it. */
    evidence: {
      lastHeaders,
      recentLimitHits: limitHits.slice(),
      // Per Function instance: SWA may run several, and this resets when one
      // recycles. A floor on what this app spent, never a total for the account.
      thisInstance: {
        requestsLastHour: requestLog.filter((r) => r.at > now - HOUR_MS).length,
        lastHourByOutcome: outcomes(now),
        since: instanceStartedAt,
      },
    },
  };
}
