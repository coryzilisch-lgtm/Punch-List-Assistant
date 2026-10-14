import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The 228-item Darden import, 2026-10-12: 147 items landed, then every later
 * item drew a 429, and a retry 40 minutes later hit an empty quota again. The
 * app never read Procore's quota headers, so it could neither see that coming
 * nor stop once it arrived: each refused item was retried up to four times, and
 * the dashboard went on to send 78 more items into the same wall.
 */

process.env.PROCORE_CLIENT_ID = 'id';
process.env.PROCORE_CLIENT_SECRET = 'secret';
process.env.PROCORE_COMPANY_ID = '18895';
process.env.PROCORE_REDIRECT_URI = 'https://app.example/api/procore/callback';
process.env.PROCORE_SESSION_KEY = 'test-session-key-that-is-at-least-32-chars';

const quota = await import('../dist/lib/quota.js');

// Every Procore call runs as a connected superintendent now; there is no
// service-account token. These tests are about rate limits and write safety,
// so they run as one.
const { runAsProcoreUser } = await import('../dist/lib/procore-session.js');
const TEST_SUPER = { accessToken: 'user-token', expiresAt: Date.now() + 3_600_000, owner: 'entra-oid', procoreUserId: 42, name: 'Test Super', login: 'super@example.com' };
const asSuper = (fn) => (...args) => runAsProcoreUser(TEST_SUPER, () => fn(...args));
const procoreRequest = asSuper((await import('../dist/lib/procore.js')).procoreRequest);
const pushHandler = asSuper((await import('../dist/functions/push.js')).pushHandler);

const realFetch = globalThis.fetch;
const headers = (h) => ({ get: (k) => h[k] ?? null });

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/oauth/token') {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 });
    }
    const call = { method: init.method || 'GET', path: u.pathname };
    calls.push(call);
    return handler(call, calls.length);
  };
  return calls;
}

const reply = (status, body, h = {}) => new Response(JSON.stringify(body), { status, headers: h });
const signedIn = (body) => ({ text: async () => JSON.stringify(body), headers: { get: () => null } });
const ctx = { log() {}, error() {}, warn() {} };
const item = (id) => ({ clientId: id, name: `Item ${id}`, punchItemManagerId: 4410 });

test.beforeEach(() => quota.resetQuotaForTests());
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── Reading the headers ─────────────────────────────────────────────────────

test('quota headers are read, with the reset as a duration or an epoch', () => {
  const now = 1_800_000_000_000;
  const q = quota.readQuota(
    headers({ 'X-Rate-Limit-Limit': '3600', 'X-Rate-Limit-Remaining': '412', 'X-Rate-Limit-Reset': '900' }),
    now,
  );
  assert.deepEqual(q, { limit: 3600, remaining: 412, resetAt: now + 900_000, observedAt: now });

  const epoch = quota.readQuota(
    headers({ 'X-Rate-Limit-Limit': '3600', 'X-Rate-Limit-Remaining': '5', 'X-Rate-Limit-Reset': '1800000600' }),
    now,
  );
  assert.equal(epoch.resetAt, 1_800_000_600_000);
});

test('a reset minutes away on a spike-sized limit is read as the 10-second window', () => {
  // 2026-10-14, the Darden import: the push stopped "for the hourly limit" and
  // carried on when Create was pressed seconds later. A 25-request limit is
  // Procore's spike window, which lasts 10 seconds, whatever Reset says.
  const now = 1_800_000_000_000;
  const spike = quota.readQuota(
    headers({ 'X-Rate-Limit-Limit': '25', 'X-Rate-Limit-Remaining': '0', 'X-Rate-Limit-Reset': '1800002000' }),
    now,
  );
  assert.ok(spike.resetAt - now <= quota.SPIKE_WINDOW_MS + 1_000);
  // No limit reported at all: not proof of the hourly limit either.
  const unknown = quota.readQuota(headers({ 'X-Rate-Limit-Remaining': '0', 'X-Rate-Limit-Reset': '1800002000' }), now);
  assert.ok(unknown.resetAt - now <= quota.SPIKE_WINDOW_MS + 1_000);
});

test('a response with no quota headers is not mistaken for an empty quota', () => {
  assert.equal(quota.readQuota(headers({}), Date.now()), null);
});

test('capacity leaves the reserve for the Safety Dashboard ingest', () => {
  const now = Date.now();
  const at = (remaining) => quota.pushCapacity({ limit: 3600, remaining, resetAt: now + 60_000, observedAt: now }, now);
  assert.equal(at(3600), Math.floor((3600 - quota.QUOTA_RESERVE) / quota.REQUESTS_PER_ITEM));
  assert.equal(at(quota.QUOTA_RESERVE + 2 * quota.REQUESTS_PER_ITEM), 2);
  assert.equal(at(quota.QUOTA_RESERVE), 0);
  assert.equal(at(10), 0, 'never negative');
});

test('capacity is unknown, not zero, without a Remaining header or after the reset', () => {
  const now = Date.now();
  assert.equal(quota.pushCapacity(null, now), null);
  assert.equal(quota.pushCapacity({ limit: 3600, remaining: null, resetAt: null, observedAt: now }, now), null);
  assert.equal(quota.pushCapacity({ limit: 3600, remaining: 0, resetAt: now - 1, observedAt: now - 5 }, now), null);
});

// ── Not spending requests against a spent window ─────────────────────────────

test('a 429 with Remaining 0 is not retried', async () => {
  const calls = mockFetch(() =>
    reply(429, {}, { 'X-Rate-Limit-Remaining': '0', 'X-Rate-Limit-Reset': '2400' }),
  );
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/me'), (err) => err.status === 429 && err.resetAt > Date.now());
  assert.equal(calls.length, 1);
});

test('once the window is spent, later calls are refused without calling Procore', async () => {
  const calls = mockFetch(() => reply(429, {}, { 'X-Rate-Limit-Remaining': '0', 'X-Rate-Limit-Reset': '2400' }));
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/me'));
  await assert.rejects(procoreRequest('POST', '/rest/v1.1/punch_items'), (err) => err.status === 429);
  assert.equal(calls.length, 1, 'the second call never reached Procore');
});

test('a 429 resetting in minutes counts as spent even without a Remaining header', async () => {
  const calls = mockFetch(() => reply(429, {}, { 'X-Rate-Limit-Reset': '2400' }));
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/me'));
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/me'));
  assert.equal(calls.length, 1);
});

test('a short 429 with quota left is still waited out and retried', async () => {
  const calls = mockFetch((_c, n) =>
    n === 1
      ? reply(429, {}, { 'X-Rate-Limit-Remaining': '900', 'X-Rate-Limit-Reset': '1' })
      : reply(200, { id: 1 }, { 'X-Rate-Limit-Remaining': '899' }),
  );
  const row = await procoreRequest('GET', '/rest/v1.0/me');
  assert.equal(row.id, 1);
  assert.equal(calls.length, 2);
});

test('the snapshot ends when the window resets', () => {
  const now = Date.now();
  quota.recordQuota({ limit: 3600, remaining: 0, resetAt: now + 1000, observedAt: now });
  assert.ok(quota.exhaustedUntil(now));
  assert.equal(quota.exhaustedUntil(now + 1001), null);
});

// ── The push ─────────────────────────────────────────────────────────────────

test('a push that will not fit inside the reserve is refused before any write', async () => {
  const now = Date.now();
  quota.recordQuota({
    limit: 3600,
    remaining: quota.QUOTA_RESERVE + 2 * quota.REQUESTS_PER_ITEM,
    resetAt: now + 600_000,
    observedAt: now,
  });
  const calls = mockFetch(() => reply(200, { id: 1 }));

  const res = await pushHandler(signedIn({ projectId: 1, items: [1, 2, 3, 4, 5].map(String).map(item) }), ctx);

  assert.equal(res.status, 429);
  assert.equal(res.jsonBody.quota.capacity, 2);
  assert.equal(calls.length, 0);
});

test('a push stops at the first spent window and marks the rest as never sent', async () => {
  // Item 1 lands; item 2's create draws the long 429. Items 3-5 must not be tried.
  const calls = mockFetch((c) => {
    if (c.method === 'POST' && calls.filter((x) => x.method === 'POST').length === 1) {
      return reply(200, { id: 7 }, { 'X-Rate-Limit-Remaining': '3000' });
    }
    if (c.method === 'POST') return reply(429, {}, { 'X-Rate-Limit-Remaining': '0', 'X-Rate-Limit-Reset': '2400' });
    return reply(200, { id: 7, workflow_status: 'draft' }, { 'X-Rate-Limit-Remaining': '2999' });
  });

  const res = await pushHandler(signedIn({ projectId: 1, items: [1, 2, 3, 4, 5].map(String).map(item) }), ctx);
  const { results } = res.jsonBody;

  assert.equal(results[0].ok, true);
  for (const r of results.slice(1)) {
    assert.equal(r.ok, false);
    assert.equal(r.rateLimited, true, JSON.stringify(r));
    assert.ok(r.resetAt > Date.now());
  }
  assert.deepEqual(
    calls.map((c) => c.method),
    ['POST', 'GET', 'POST'],
    'one create, its read-back, and the one refused create; nothing after',
  );
  assert.equal(res.jsonBody.quota.remaining, 0);
});

// ── The tenant's real window, 2026-10-13 ─────────────────────────────────────

test('the tenant\'s own reading has room to push: 23 of 25 left', () => {
  // The first version reserved a flat 200 requests, sized for an hourly quota.
  // Procore reported Limit 25, so capacity was 0 forever and nothing pushed.
  const now = Date.now();
  const q = { limit: 25, remaining: 23, resetAt: now + 30_000, observedAt: now };
  assert.equal(quota.reserveFor(q), 2);
  assert.equal(quota.pushCapacity(q, now), 7);
});

test('the reserve is a tenth of the window, capped for a large one', () => {
  assert.equal(quota.reserveFor({ limit: 3600, remaining: 1, resetAt: null, observedAt: 0 }), quota.QUOTA_RESERVE);
  assert.equal(quota.reserveFor({ limit: 1000, remaining: 1, resetAt: null, observedAt: 0 }), 100);
  assert.equal(quota.reserveFor(null), quota.QUOTA_RESERVE, 'unknown limit keeps the cap');
});

test('a spent window that resets in a moment is waited out, not refused', async () => {
  const now = Date.now();
  quota.recordQuota({ limit: 25, remaining: 0, resetAt: now + 300, observedAt: now });
  const calls = mockFetch(() => reply(200, { id: 1 }, { 'X-Rate-Limit-Limit': '25', 'X-Rate-Limit-Remaining': '24' }));
  const started = Date.now();
  const row = await procoreRequest('GET', '/rest/v1.0/me');
  assert.equal(row.id, 1);
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started >= 300, 'it waited for the reset');
});

test('a push is not stopped by a window that resets in a moment', async () => {
  const now = Date.now();
  quota.recordQuota({ limit: 25, remaining: 20, resetAt: now + 30_000, observedAt: now });
  let posts = 0;
  mockFetch((c) => {
    if (c.method === 'POST') {
      posts += 1;
      // The second create spends the window, which resets almost at once.
      return reply(200, { id: posts }, { 'X-Rate-Limit-Limit': '25', 'X-Rate-Limit-Remaining': posts === 2 ? '0' : '15', 'X-Rate-Limit-Reset': '1' });
    }
    return reply(200, { id: posts, workflow_status: 'draft' }, { 'X-Rate-Limit-Limit': '25', 'X-Rate-Limit-Remaining': '24' });
  });
  const res = await pushHandler(signedIn({ projectId: 1, items: ['a', 'b', 'c'].map(item) }), ctx);
  assert.deepEqual(res.jsonBody.results.map((r) => r.ok), [true, true, true]);
});

// ── Which limit is it? Evidence, not conclusions ─────────────────────────────

const quotaHandler = asSuper((await import('../dist/functions/quota.js')).quotaHandler);

test('the rate headers are kept verbatim, whatever Procore calls them', async () => {
  mockFetch(() =>
    reply(200, { id: 1 }, {
      'X-Rate-Limit-Limit': '25',
      'X-Rate-Limit-Remaining': '23',
      'X-Rate-Limit-Reset': '1800000000',
      'Retry-After': '9',
      'X-Request-Id': 'not-rate-related',
    }),
  );
  await procoreRequest('GET', '/rest/v1.0/me');
  const { evidence } = quota.quotaReport(Date.now());
  assert.deepEqual(evidence.lastHeaders.headers, {
    'x-rate-limit-limit': '25',
    'x-rate-limit-remaining': '23',
    'x-rate-limit-reset': '1800000000',
    'retry-after': '9',
  });
});

test('a 429 is logged as short or long by how far out it resets', async () => {
  let n = 0;
  mockFetch(() => {
    n += 1;
    if (n === 1) return reply(429, {}, { 'X-Rate-Limit-Reset': '1' });
    if (n === 2) return reply(200, { id: 1 });
    // Only an hourly-scale limit can mean a long wait.
    return reply(429, {}, { 'X-Rate-Limit-Limit': '3600', 'X-Rate-Limit-Reset': '2100' });
  });
  await procoreRequest('GET', '/rest/v1.0/me'); // short 429, waited out, then 200
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/me')); // the hourly-scale wall
  const hits = quota.quotaReport(Date.now()).evidence.recentLimitHits;
  assert.deepEqual(hits.map((h) => h.window), ['short', 'long']);
  assert.ok(hits[1].resetAt - hits[1].at > 2_000_000);
});

test('/api/quota reports this instance\'s requests over the last hour', async () => {
  mockFetch(() => reply(200, { id: 1 }, { 'X-Rate-Limit-Limit': '25', 'X-Rate-Limit-Remaining': '20', 'X-Rate-Limit-Reset': '30' }));
  await procoreRequest('GET', '/rest/v1.0/me');
  await procoreRequest('GET', '/rest/v1.0/me');
  const res = await quotaHandler({});
  assert.equal(res.jsonBody.evidence.thisInstance.requestsLastHour, 3, 'two calls plus the quota check itself');
  assert.equal(res.jsonBody.window, 'short');
  assert.equal(res.jsonBody.requests, 1);
});

test('a push reports what it cost, and whether the create already said what the read-back did', async () => {
  const stored = { id: 7, workflow_status: 'draft', has_attachments: false, attachments: [] };
  mockFetch((c) => reply(200, c.method === 'POST' ? stored : stored));
  const agree = await pushHandler(signedIn({ projectId: 1, items: [item('a')] }), ctx);
  assert.equal(agree.jsonBody.requests, 2, 'create and read-back');
  assert.deepEqual(agree.jsonBody.results[0].echo, { agrees: true, differs: [] });

  // A create that answers with a bare id cannot stand in for the read-back.
  mockFetch((c) => reply(200, c.method === 'POST' ? { id: 7 } : stored));
  const bare = await pushHandler(signedIn({ projectId: 1, items: [item('a')] }), ctx);
  assert.equal(bare.jsonBody.results[0].echo.agrees, false);
  assert.ok(bare.jsonBody.results[0].echo.differs.includes('isDraft'));
});

// ── Procore's documented rules (rate-limiting docs, pasted by Cory 2026-10-13) ─

test('a 429 is retried once after its reset, never more: failed requests count too', async () => {
  // "Every request your app sends counts against your rate limit, including
  // requests that fail." Four retries per 429 is what made each refused item on
  // the Darden import cost five requests.
  const calls = mockFetch(() => reply(429, {}, { 'X-Rate-Limit-Limit': '25', 'X-Rate-Limit-Reset': '1' }));
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/me'), (err) => err.status === 429);
  assert.equal(calls.length, 2);
});

test('after a 429, the next request waits for the reset instead of firing into it', async () => {
  let n = 0;
  const times = [];
  mockFetch(() => {
    times.push(Date.now());
    n += 1;
    return n === 1 ? reply(429, {}, { 'X-Rate-Limit-Reset': '1' }) : reply(200, { id: 1 });
  });
  await procoreRequest('GET', '/rest/v1.0/me');
  assert.equal(n, 2);
  assert.ok(times[1] - times[0] >= 900, `retried after ${times[1] - times[0]}ms`);
});

test('a 503 on a read honours Retry-After; a 503 on a write is not retried', async () => {
  let n = 0;
  mockFetch(() => (++n === 1 ? reply(503, {}, { 'Retry-After': '1' }) : reply(200, { id: 1 })));
  const row = await procoreRequest('GET', '/rest/v1.0/me');
  assert.equal(row.id, 1);
  assert.equal(n, 2);

  const calls = mockFetch(() => reply(503, {}, { 'Retry-After': '1' }));
  await assert.rejects(procoreRequest('POST', '/rest/v1.1/punch_items'), (err) => err.status === 503);
  assert.equal(calls.length, 1, 'a write that drew a 503 may still have been performed');
});

test('the last hour is broken down by outcome, because failures spend quota too', async () => {
  let n = 0;
  mockFetch(() => {
    n += 1;
    if (n === 1) return reply(200, { id: 1 });
    if (n === 2) return reply(404, {});
    return reply(429, {}, { 'X-Rate-Limit-Reset': '2400' });
  });
  await procoreRequest('GET', '/rest/v1.0/me');
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/nope'));
  await assert.rejects(procoreRequest('GET', '/rest/v1.0/me'));
  const o = quota.quotaReport(Date.now()).evidence.thisInstance.lastHourByOutcome;
  assert.deepEqual(o, { total: 3, ok: 1, rateLimited: 1, clientErrors: 1, serverErrors: 0, noResponse: 0 });
});

test('requests are paced under the spike window: the 21st in ten seconds waits', async () => {
  const { resetPacingForTests } = await import('../dist/lib/procore.js');
  resetPacingForTests();
  quota.resetQuotaForTests();
  mockFetch(() => reply(200, { id: 1 }));
  const start = Date.now();
  for (let i = 0; i < 20; i++) await procoreRequest('GET', '/rest/v1.0/me');
  assert.ok(Date.now() - start < 2_000, 'twenty go straight through');
  await procoreRequest('GET', '/rest/v1.0/me');
  assert.ok(Date.now() - start >= 9_500, 'the next one waits for the window');
  resetPacingForTests();
});
