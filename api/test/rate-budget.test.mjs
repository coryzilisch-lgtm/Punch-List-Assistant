import test from 'node:test';
import assert from 'node:assert/strict';

import { cached, bust, clearCache } from '../dist/lib/cache.js';

/**
 * The case that actually caused the 429s: selecting a project fired
 * `/api/projects/{id}/config` and `/api/probe` **in parallel**, and the probe
 * built its own copy of the same ~7 Procore requests. A result cache alone
 * cannot help there — neither call had finished when the other started. Joining
 * the in-flight promise is what collapses the two into one.
 */
test('two callers racing for the same key share one fetch', async () => {
  clearCache();
  let calls = 0;
  const load = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return 'trades';
  };

  const [a, b] = await Promise.all([cached('k', 60_000, load), cached('k', 60_000, load)]);

  assert.equal(calls, 1, 'a concurrent duplicate must not start a second fetch');
  assert.equal(a, 'trades');
  assert.equal(b, 'trades');
});

test('a settled value is reused inside its TTL and refetched after', async () => {
  clearCache();
  let calls = 0;
  const load = async () => { calls += 1; return calls; };

  assert.equal(await cached('k', 60_000, load), 1);
  assert.equal(await cached('k', 60_000, load), 1);
  assert.equal(calls, 1);

  // A zero TTL is always expired, which is how "always refetch" is expressed.
  assert.equal(await cached('k', 0, load), 2);
});

/**
 * A cached failure is worse than no cache: it turns one transient 429 into a
 * guaranteed minute of failure for everyone, which is the same mistake the write
 * chains make when they record a rate limit as a broken contract.
 */
test('a failure is never cached', async () => {
  clearCache();
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) throw new Error('429');
    return 'ok';
  };

  await assert.rejects(() => cached('k', 60_000, load), /429/);
  assert.equal(await cached('k', 60_000, load), 'ok', 'the retry must reach Procore');
  assert.equal(calls, 2);
});

/** Everyone waiting on a failed fetch must see the failure, not a hung promise. */
test('both racers see the error when the shared fetch fails', async () => {
  clearCache();
  const load = async () => {
    await new Promise((r) => setTimeout(r, 10));
    throw new Error('boom');
  };
  const results = await Promise.allSettled([cached('k', 60_000, load), cached('k', 60_000, load)]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
});

test('bust clears a key and its children, and nothing else', async () => {
  clearCache();
  const load = (v) => async () => v;
  await cached('punch-config:1', 60_000, load('a'));
  await cached('punch-config:2', 60_000, load('b'));
  await cached('projects', 60_000, load('c'));

  bust('punch-config');

  let refetched = 0;
  await cached('punch-config:1', 60_000, async () => { refetched += 1; return 'a2'; });
  await cached('projects', 60_000, async () => { refetched += 1; return 'c2'; });

  assert.equal(refetched, 1, 'only the busted prefix should be refetched');
});

/** A key that merely shares a prefix string is a different key. */
test('bust does not clear a key that only shares a word', async () => {
  clearCache();
  await cached('punch-config-extra', 60_000, async () => 'keep');
  bust('punch-config');
  let refetched = false;
  await cached('punch-config-extra', 60_000, async () => { refetched = true; return 'x'; });
  assert.equal(refetched, false);
});

import { paginateWithBudget } from '../dist/lib/procore.js';

process.env.PROCORE_CLIENT_ID ||= 'x';
process.env.PROCORE_CLIENT_SECRET ||= 'x';
process.env.PROCORE_COMPANY_ID ||= '18895';

/** Serve `total` rows, honouring at most `serverMax` per page. */
function stubProcore({ total, serverMax }) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 });
    }
    const page = Number(u.searchParams.get('page') || 1);
    const per = Math.min(Number(u.searchParams.get('per_page') || 100), serverMax);
    seen.push(per);
    const start = (page - 1) * per;
    const rows = Array.from({ length: Math.max(0, Math.min(per, total - start)) }, (_, i) => ({
      id: start + i + 1,
    }));
    return new Response(JSON.stringify(rows), { status: 200, headers: { Total: String(total) } });
  };
  return seen;
}

/**
 * THE TRAP. Asking for 1000 rows from an endpoint that caps pages at 100 makes
 * the first page arrive "short" — and the old rule, `rows.length < perPage means
 * we are done`, reads the SERVER's page size as if it were ours. An 800-item
 * punch list would come back as its first 100, silently, presented as complete.
 * That is a wrong answer delivered as a right one, which is exactly the failure
 * shape this integration keeps hitting.
 */
test('a server that caps the page size does not truncate the list', async () => {
  stubProcore({ total: 800, serverMax: 100 });
  const { rows, truncated } = await paginateWithBudget('/rest/v1.1/punch_items', {}, 1000, 0);
  assert.equal(rows.length, 800, 'every row must be fetched even when the page size is capped');
  assert.equal(truncated, false);
});

test('a server that honours a big page fetches the list in one request', async () => {
  const seen = stubProcore({ total: 800, serverMax: 1000 });
  const { rows } = await paginateWithBudget('/rest/v1.1/punch_items', {}, 1000, 0);
  assert.equal(rows.length, 800);
  assert.equal(seen.length, 1, '800 rows in one page should cost one request');
});

/** Without a Total header the row count is all there is, and it still works. */
test('pagination still terminates when Procore sends no Total header', async () => {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 });
    }
    const page = Number(u.searchParams.get('page') || 1);
    const rows = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : [];
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  const { rows, truncated } = await paginateWithBudget('/x', {}, 100, 0);
  assert.equal(rows.length, 100);
  assert.equal(truncated, false);
});
