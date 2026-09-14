/**
 * A tiny process-level cache, because the Procore quota is shared and small.
 *
 * Procore's limit is ~3,600 requests/hour and it is **company-wide**: this app's
 * service account is the same one the Safety Dashboard's nightly ingest uses, so
 * the budget is not ours alone and a burst here can be throttled by work nobody
 * in this app started. The first live run of the lists probe proved it — two
 * lookups came back 429 on a project where the control call had just succeeded.
 *
 * Two things are cached, and the second matters more than the first:
 *
 * 1. **Results**, for a TTL. A project's trades, vendors, types and locations do
 *    not change while a superintendent reviews sixty rows.
 * 2. **In-flight promises.** Two requests for the same thing arriving at once
 *    share one fetch instead of racing. This is the case that actually bit:
 *    selecting a project fired `/api/projects/{id}/config` and `/api/probe`
 *    **in parallel**, and a result cache alone cannot help — neither had
 *    finished when the other started.
 *
 * Scope is one Function instance. SWA may run several, so this reduces calls
 * rather than bounding them; that is the right shape for a rate limit, which is
 * about volume, not correctness. Nothing here is a source of truth: every entry
 * is a copy of something Procore can be asked for again.
 */

interface Entry<T> {
  /** Present from the moment work starts, so concurrent callers can join it. */
  promise: Promise<T>;
  /** Set when the promise resolves; until then the entry is in flight. */
  settledAt: number | null;
  ttlMs: number;
}

const entries = new Map<string, Entry<unknown>>();

/** Long enough to cover a review session, short enough that a Procore edit lands. */
export const CONFIG_TTL_MS = 10 * 60_000;
/** Short: this one exists to stop two endpoints in one page load from both paying. */
export const LIST_TTL_MS = 60_000;

export function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const existing = entries.get(key) as Entry<T> | undefined;

  if (existing) {
    // Still running — join it rather than starting a second identical fetch.
    if (existing.settledAt === null) return existing.promise;
    if (Date.now() - existing.settledAt < ttlMs) return existing.promise;
  }

  const entry: Entry<T> = { promise: load(), settledAt: null, ttlMs };
  entry.promise = entry.promise.then(
    (value) => {
      entry.settledAt = Date.now();
      return value;
    },
    (err) => {
      // A failure is never cached. Caching one turns a transient 429 into a
      // minute of guaranteed failure for everybody — the same mistake the write
      // chains make when they record a rate limit as a broken contract.
      entries.delete(key);
      throw err;
    },
  );
  entries.set(key, entry);
  return entry.promise;
}

/** Drop an entry — used after a write makes the cached copy wrong. */
export function bust(prefix: string): void {
  for (const key of entries.keys()) {
    if (key === prefix || key.startsWith(`${prefix}:`)) entries.delete(key);
  }
}

/** Testing and diagnostics only. */
export function clearCache(): void {
  entries.clear();
}
