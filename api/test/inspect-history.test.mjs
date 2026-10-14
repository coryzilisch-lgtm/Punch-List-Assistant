import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * /api/inspect's history mode: who moved an item, and when.
 *
 * Asked on 2026-10-14, when punch item #953 turned up Work Required and nobody
 * had sent it. It must stay strictly read-only: it is the tool for finding out
 * what wrote to an item, so it can never be one more thing that did.
 */

process.env.PROCORE_CLIENT_ID = 'id';
process.env.PROCORE_CLIENT_SECRET = 'secret';
process.env.PROCORE_COMPANY_ID = '18895';
process.env.PROCORE_REDIRECT_URI = 'https://app.example/api/procore/callback';
process.env.PROCORE_SESSION_KEY = 'test-session-key-that-is-at-least-32-chars';

const { runAsProcoreUser } = await import('../dist/lib/procore-session.js');
const SUPER = { accessToken: 't', expiresAt: Date.now() + 3_600_000, owner: 'o', procoreUserId: 42, name: 'S', login: 's@x' };
const { inspectHandler } = await import('../dist/functions/inspect.js');
const inspect = (query) =>
  runAsProcoreUser(SUPER, () =>
    inspectHandler({ query: { get: (k) => query[k] ?? null }, headers: { get: () => null } }, { log() {}, error() {}, warn() {} }),
  );

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname });
    return handler(u);
  };
  return calls;
}
const reply = (status, body) => new Response(JSON.stringify(body), { status });

test('history finds an item by its number, asks only GETs, and stops at the first history with rows', async () => {
  const calls = mockFetch((u) => {
    if (u.pathname === '/rest/v1.1/punch_items') return reply(200, [{ id: 7001, position: 952 }, { id: 7002, position: 953 }]);
    if (u.pathname.endsWith('/7002/change_history') && u.pathname.startsWith('/rest/v1.1/')) {
      return reply(200, [{ action: 'Status changed', from: 'Initiated', to: 'Work Required', created_by: { name: 'Someone' } }]);
    }
    if (u.pathname === '/rest/v1.1/punch_items/7002') return reply(200, { id: 7002, position: 953, workflow_status: 'work_required' });
    return reply(404, { errors: 'not found' });
  });
  const res = await inspect({ project_id: '603781', punch_item_number: '953', history: '1' });
  assert.equal(res.jsonBody.punchItemId, 7002);
  assert.equal(res.jsonBody.now.workflow_status, 'work_required');
  const found = res.jsonBody.history.find((h) => h.status === 'ok');
  assert.equal(found.rows, 1);
  assert.equal(found.sample[0].to, 'Work Required');
  assert.ok(calls.every((c) => c.method === 'GET'), 'read-only');
  assert.ok(!calls.some((c) => c.path.endsWith('/history') && !c.path.endsWith('change_history')), 'stopped once a history answered');
});

test('a number that matches nothing says so', async () => {
  mockFetch(() => reply(200, []));
  const res = await inspect({ project_id: '603781', punch_item_number: '999', history: '1' });
  assert.equal(res.status, 404);
});
