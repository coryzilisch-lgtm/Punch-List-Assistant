import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 2026-10-01: one import put ~350 emails in front of every sub on a project.
 *
 * Sending is the one thing this app does that reaches people outside Buffalo,
 * and three things in the code could each multiply a single send:
 *
 *   1. a write that failed with a 5xx or a dropped socket was retried, though
 *      Procore may already have performed it;
 *   2. the send chain tried up to three different send writes per item when the
 *      read-back could not prove the first had worked;
 *   3. nothing stopped a deployment from sending at all.
 *
 * Each gets a test, because each failure looks like success from inside the app.
 */

process.env.PROCORE_CLIENT_ID = 'id';
process.env.PROCORE_CLIENT_SECRET = 'secret';
process.env.PROCORE_COMPANY_ID = '18895';

const { procoreRequest, sendEnabled, sendPunchItem } = await import('../dist/lib/procore.js');
const { pushHandler } = await import('../dist/functions/push.js');
const { resendHandler } = await import('../dist/functions/resend.js');

const realFetch = globalThis.fetch;

/** Route Procore calls to `handler`; the token mint always succeeds. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/oauth/token') {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 });
    }
    const call = { method: init.method || 'GET', path: u.pathname };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PUNCH_SEND_ENABLED;
});

const ok = (body = {}) => new Response(JSON.stringify(body), { status: 200 });

test('a write that got a 500 is not retried, because Procore may have done it', async () => {
  const calls = mockFetch(() => new Response('{}', { status: 500 }));
  await assert.rejects(procoreRequest('POST', '/rest/v1.1/punch_items/1/send'));
  assert.equal(calls.length, 1);
});

test('a write that lost its connection is not retried', async () => {
  let n = 0;
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === '/oauth/token') {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 });
    }
    n += 1;
    throw new TypeError('socket hang up');
  };
  await assert.rejects(procoreRequest('PATCH', '/rest/v1.1/punch_items/1'));
  assert.equal(n, 1);
});

test('a read still retries a 500', async () => {
  let n = 0;
  mockFetch(() => (++n < 2 ? new Response('{}', { status: 500 }) : ok({ id: 1 })));
  const row = await procoreRequest('GET', '/rest/v1.1/punch_items/1');
  assert.equal(row.id, 1);
  assert.equal(n, 2);
});

test('sending is off unless PUNCH_SEND_ENABLED=true', () => {
  assert.equal(sendEnabled(), false);
  for (const v of ['', '1', 'yes', 'TRUEISH']) {
    process.env.PUNCH_SEND_ENABLED = v;
    assert.equal(sendEnabled(), false, JSON.stringify(v));
  }
  process.env.PUNCH_SEND_ENABLED = 'true';
  assert.equal(sendEnabled(), true);
});

const signedIn = (body) => ({
  text: async () => JSON.stringify(body),
  headers: { get: () => null },
});
const ctx = { log() {}, error() {}, warn() {} };

test('a push asking to send is refused before anything is created when sending is off', async () => {
  const calls = mockFetch(() => ok({ id: 1 }));
  const res = await pushHandler(
    signedIn({ projectId: 1, send: true, items: [{ clientId: 'a', name: 'Cracked tile' }] }),
    ctx,
  );
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test('resend is refused when sending is off', async () => {
  const calls = mockFetch(() => ok({ id: 1 }));
  const res = await resendHandler(signedIn({ projectId: 1, punchItemIds: [1] }), ctx);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

// Runs last: the send chain memoises its verdict for the life of the process.
test('an accepted send that cannot be verified is not followed by a second send method', async () => {
  const calls = mockFetch((c) =>
    c.method === 'GET' ? ok({ id: 7, status: 'Open', workflow_status: 'draft' }) : ok({}),
  );
  const before = { status: 'Open', workflowLabel: 'draft', isDraft: true, ballInCourt: [], assignees: [] };
  const result = await sendPunchItem(1, 7, before);

  const writes = calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 1, `expected one send write, got ${writes.map((w) => w.method).join(', ')}`);
  assert.equal(result.sent, false);
});
