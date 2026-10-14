import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The permanent Procore link (Cory, 2026-10-14): connect once, stay connected.
 *
 * Runs against an in-memory stand-in for Azure Table Storage that honours
 * ETags the way the real service does, because the conditional write is the
 * property that matters: two tabs refreshing at once must not sign a super out.
 */

process.env.PROCORE_CLIENT_ID = 'client-id';
process.env.PROCORE_CLIENT_SECRET = 'client-secret';
process.env.PROCORE_COMPANY_ID = '18895';
process.env.PROCORE_REDIRECT_URI = 'https://app.example/api/procore/callback';
process.env.PROCORE_SESSION_KEY = 'test-session-key-that-is-at-least-32-chars';
process.env.PROCORE_LINK_STORE =
  'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=' + Buffer.from('k'.repeat(32)).toString('base64') + ';EndpointSuffix=core.windows.net';

const session = await import('../dist/lib/procore-session.js');
const { guarded } = await import('../dist/lib/http.js');
const { procoreRequest } = await import('../dist/lib/procore.js');
const { connectHandler, callbackHandler, disconnectHandler } = await import('../dist/functions/procore-auth.js');

const OWNER = 'entra-oid-cory';
const ctx = { log() {}, error() {}, warn() {} };
const principal = (id) =>
  Buffer.from(JSON.stringify({ userId: id, userDetails: 'c@x', identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64');
function request({ owner = OWNER, cookie = null, query = {} } = {}) {
  const h = new Map();
  if (owner) h.set('x-ms-client-principal', principal(owner));
  if (cookie) h.set('cookie', cookie);
  return { headers: { get: (k) => h.get(k.toLowerCase()) ?? null }, query: { get: (k) => query[k] ?? null }, text: async () => '' };
}
const reply = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

/** A fake Table service plus fake Procore. `procore(call)` answers Procore calls. */
function world(procore) {
  const rows = new Map();
  let etagN = 0;
  let tableExists = true;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const call = { method, host: u.host, path: decodeURIComponent(u.pathname), headers: init.headers || {}, body: init.body };
    calls.push(call);
    if (u.host === 'acct.table.core.windows.net') {
      assert.match(call.headers.Authorization, /^SharedKeyLite acct:/);
      if (call.path === '/Tables') {
        tableExists = true;
        return reply(201, {});
      }
      const key = call.path.match(/RowKey='([^']+)'/)[1];
      const ifMatch = call.headers['If-Match'];
      const row = rows.get(key);
      if (method === 'GET') return row ? reply(200, row.data, { ETag: row.etag }) : reply(404, {});
      if (method === 'DELETE') {
        if (!row) return reply(404, {});
        rows.delete(key);
        return reply(204);
      }
      if (method === 'PUT') {
        if (!tableExists) return reply(404, {});
        if (ifMatch && ifMatch !== '*' && (!row || row.etag !== ifMatch)) return reply(412, {});
        const etag = `W/"${++etagN}"`;
        rows.set(key, { data: JSON.parse(call.body), etag });
        return reply(204, undefined, { ETag: etag });
      }
    }
    return procore(call);
  };
  return {
    rows,
    calls,
    dropTable() {
      tableExists = false;
    },
    put(owner, value) {
      rows.set(owner, { data: { PartitionKey: 'u', RowKey: owner, link: session.seal(value) }, etag: `W/"${++etagN}"` });
    },
    stored(owner) {
      const r = rows.get(owner);
      return r && session.unseal(r.data.link);
    },
  };
}

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const linked = (over = {}) => ({
  accessToken: 'old-access',
  expiresAt: Date.now() - 1000, // spent
  owner: OWNER,
  procoreUserId: 4410,
  name: 'Cory Zilisch',
  login: 'cory@x',
  refreshToken: 'refresh-1',
  ...over,
});
const meRoute = guarded('t', async () => ({ status: 200, jsonBody: await procoreRequest('GET', '/rest/v1.0/me') }));

test('connecting keeps a sealed link: the refresh token is never stored or sent in the clear', async () => {
  const w = world((c) =>
    c.path === '/oauth/token'
      ? reply(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 7200 })
      : reply(200, { id: 4410, name: 'Cory Zilisch', login: 'cory@x' }),
  );
  w.dropTable(); // first link ever: the table is created on the way
  const start = await connectHandler(request());
  const state = new URL(start.headers.Location).searchParams.get('state');
  const stateCookie = `${session.STATE_COOKIE}=${start.cookies.find((c) => c.name === session.STATE_COOKIE).value}`;
  const res = await callbackHandler(request({ owner: null, cookie: stateCookie, query: { code: 'c', state } }), ctx);

  assert.equal(res.status, 200);
  assert.match(res.body, /stay connected/);
  const raw = JSON.stringify(w.rows.get(OWNER).data);
  assert.ok(!raw.includes('refresh-1') && !raw.includes('access-1'), 'nothing readable at rest');
  assert.equal(w.stored(OWNER).refreshToken, 'refresh-1');
  const cookie = session.unseal(res.cookies.find((c) => c.name === session.SESSION_COOKIE).value);
  assert.ok(!('refreshToken' in cookie), 'the cookie never carries the refresh token');
});

test('with no cookie, a linked super is reconnected: one refresh, a conditional write, a fresh cookie', async () => {
  const w = world((c) => {
    if (c.path === '/oauth/token') {
      const body = JSON.parse(c.body);
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.refresh_token, 'refresh-1');
      return reply(200, { access_token: 'new-access', refresh_token: 'refresh-2', expires_in: 7200 });
    }
    assert.equal(c.headers.Authorization, 'Bearer new-access');
    return reply(200, { id: 4410 });
  });
  w.put(OWNER, linked());
  const etagBefore = w.rows.get(OWNER).etag;
  const res = await meRoute(request(), ctx);

  assert.equal(res.status, 200);
  const put = w.calls.find((c) => c.method === 'PUT');
  assert.equal(put.headers['If-Match'], etagBefore, 'compare-and-swap on the row it read');
  assert.equal(w.stored(OWNER).refreshToken, 'refresh-2', 'a rotated refresh token replaces the old one');
  const cookie = session.unseal(res.cookies.find((c) => c.name === session.SESSION_COOKIE).value);
  assert.equal(cookie.accessToken, 'new-access');
  assert.equal(w.calls.filter((c) => c.path === '/oauth/token').length, 1);
});

test('two requests refreshing at once: the loser uses the winner\'s token instead of signing the super out', async () => {
  const w = world((c) => {
    if (c.path === '/oauth/token') {
      // While this refresh is in flight, another tab finishes its own.
      w.put(OWNER, linked({ accessToken: 'winner-access', expiresAt: Date.now() + 3_600_000, refreshToken: 'refresh-w' }));
      return reply(200, { access_token: 'loser-access', refresh_token: 'refresh-l', expires_in: 7200 });
    }
    assert.equal(c.headers.Authorization, 'Bearer winner-access');
    return reply(200, { id: 4410 });
  });
  w.put(OWNER, linked());
  const res = await meRoute(request(), ctx);
  assert.equal(res.status, 200);
  assert.equal(w.stored(OWNER).refreshToken, 'refresh-w', "the winner's row stands");
});

test('a refresh Procore refuses deletes the link and asks the super to connect', async () => {
  const w = world((c) => (c.path === '/oauth/token' ? reply(400, { error: 'invalid_grant' }) : reply(200, {})));
  w.put(OWNER, linked());
  const res = await meRoute(request(), ctx);
  assert.equal(res.status, 401);
  assert.equal(res.jsonBody.procoreConnect, true);
  assert.equal(w.rows.has(OWNER), false);
  assert.ok(!w.calls.some((c) => c.host === 'api.procore.com'), 'nothing sent to Procore without a session');
});

test('a token Procore refuses mid-request is marked spent, so the next request refreshes', async () => {
  const w = world(() => reply(401, {}));
  w.put(OWNER, linked({ accessToken: 'live-access', expiresAt: Date.now() + 3_600_000 }));
  const res = await meRoute(request(), ctx);
  assert.equal(res.status, 401);
  assert.equal(w.stored(OWNER).expiresAt, 0);
  assert.ok(res.cookies.some((c) => c.name === session.SESSION_COOKIE && c.maxAge === 0), 'the dead cookie is cleared');
});

test('another Buffalo account cannot use a link that is not theirs', async () => {
  const w = world(() => reply(200, {}));
  w.put('someone-else', linked({ owner: OWNER })); // a row whose sealed owner does not match its key
  const res = await meRoute(request({ owner: 'someone-else' }), ctx);
  assert.equal(res.status, 401);
  assert.ok(!w.calls.some((c) => c.path === '/oauth/token'));
});

test('disconnect removes the link, so nothing quietly reconnects', async () => {
  const w = world(() => reply(200, {}));
  w.put(OWNER, linked());
  const res = await guarded('d', disconnectHandler)(request(), ctx);
  assert.equal(res.status, 200);
  assert.equal(w.rows.has(OWNER), false);
});
