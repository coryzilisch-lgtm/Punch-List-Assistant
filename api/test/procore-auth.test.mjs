import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Items are created as the signed-in superintendent, on their own Procore token
 * (user-level OAuth). There is no service-account fallback (Cory, 2026-10-14):
 * an item created by a robot is the confusion this replaces. These tests hold
 * the parts where a mistake would be silent: whose token a request carries,
 * that a forged or stale callback cannot create a session, that one super's
 * cookie does not work for another, and that a token expiring mid-push stops
 * the push instead of failing every remaining item into the same 401.
 */

process.env.PROCORE_CLIENT_ID = 'client-id';
process.env.PROCORE_CLIENT_SECRET = 'client-secret';
process.env.PROCORE_COMPANY_ID = '18895';
process.env.PROCORE_REDIRECT_URI = 'https://app.example/api/procore/callback';
process.env.PROCORE_SESSION_KEY = 'test-session-key-that-is-at-least-32-chars';

const session = await import('../dist/lib/procore-session.js');
const { guarded } = await import('../dist/lib/http.js');
const { procoreRequest } = await import('../dist/lib/procore.js');
const { cached, clearCache } = await import('../dist/lib/cache.js');
const { connectHandler, callbackHandler } = await import('../dist/functions/procore-auth.js');
const { pushHandler } = await import('../dist/functions/push.js');

const realFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

const ctx = { log() {}, error() {}, warn() {} };
const OWNER = 'entra-oid-cory';

const principalHeader = (userId) =>
  Buffer.from(JSON.stringify({ userId, userDetails: `${userId}@buffalo.example`, identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64');

function request({ owner = OWNER, cookie = null, query = {}, body = null } = {}) {
  const headers = new Map();
  if (owner) headers.set('x-ms-client-principal', principalHeader(owner));
  if (cookie) headers.set('cookie', cookie);
  return {
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    query: { get: (k) => query[k] ?? null },
    text: async () => (body ? JSON.stringify(body) : ''),
  };
}

const superSession = (over = {}) => ({
  accessToken: 'cory-token',
  expiresAt: Date.now() + 3_600_000,
  owner: OWNER,
  procoreUserId: 4410,
  name: 'Cory Zilisch',
  login: 'cory@buffalo.example',
  ...over,
});

const cookieFor = (s) => `${session.SESSION_COOKIE}=${session.seal(s)}`;

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || 'GET', path: u.pathname, url: u, headers: init.headers || {}, body: init.body };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

const reply = (status, body) => new Response(JSON.stringify(body), { status });

// ── The cookie ───────────────────────────────────────────────────────────────

test('a sealed session opens with the right key and not with a tampered value', () => {
  const sealed = session.seal({ a: 1 });
  assert.deepEqual(session.unseal(sealed), { a: 1 });
  const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'B' : 'A') + sealed.slice(-1);
  assert.equal(session.unseal(flipped), null);
  assert.equal(session.unseal('not-a-cookie'), null);
});

test("one super's cookie does not work for another, nor once expired", () => {
  const now = Date.now();
  assert.ok(session.sessionFromCookie(cookieFor(superSession()), OWNER, now));
  assert.equal(session.sessionFromCookie(cookieFor(superSession()), 'someone-else', now), null);
  assert.equal(session.sessionFromCookie(cookieFor(superSession({ expiresAt: now + 30_000 })), OWNER, now), null);
});

// ── Whose token a request carries ────────────────────────────────────────────

test('a Procore request carries the signed-in super\'s own token', async () => {
  const calls = mockFetch(() => reply(200, { id: 1 }));
  const route = guarded('t', async () => ({ status: 200, jsonBody: await procoreRequest('GET', '/rest/v1.0/me') }));
  const res = await route(request({ cookie: cookieFor(superSession()) }), ctx);
  assert.equal(res.status, 200);
  assert.equal(calls[0].headers.Authorization, 'Bearer cory-token');
  assert.ok(!calls.some((c) => c.path === '/oauth/token'), 'no service-account token is ever minted');
});

test('with no Procore connection, a Procore call is refused before anything is sent', async () => {
  const calls = mockFetch(() => reply(200, {}));
  const route = guarded('t', async () => ({ status: 200, jsonBody: await procoreRequest('GET', '/rest/v1.0/me') }));
  const res = await route(request(), ctx);
  assert.equal(res.status, 401);
  assert.equal(res.jsonBody.procoreConnect, true);
  assert.equal(res.jsonBody.reason, 'not-connected');
  assert.equal(calls.length, 0);
});

test('a token Procore refuses asks the super to reconnect, distinct from the Entra sign-in', async () => {
  mockFetch(() => reply(401, {}));
  const route = guarded('t', async () => ({ status: 200, jsonBody: await procoreRequest('GET', '/rest/v1.0/me') }));
  const res = await route(request({ cookie: cookieFor(superSession()) }), ctx);
  assert.equal(res.status, 401);
  assert.equal(res.jsonBody.procoreConnect, true);
  assert.equal(res.jsonBody.reason, 'expired');
  assert.equal(res.jsonBody.signInUrl, undefined, 'not the Entra sign-in');
});

test('cached Procore answers are never shared between supers', async () => {
  clearCache();
  const a = superSession({ procoreUserId: 1 });
  const b = superSession({ procoreUserId: 2, owner: 'entra-oid-other' });
  let loads = 0;
  const load = () => Promise.resolve(++loads);
  const first = await session.runAsProcoreUser(a, () => cached('config:603781', 60_000, load));
  const second = await session.runAsProcoreUser(b, () => cached('config:603781', 60_000, load));
  const again = await session.runAsProcoreUser(a, () => cached('config:603781', 60_000, load));
  assert.deepEqual([first, second, again], [1, 2, 1]);
});

// ── Connecting ───────────────────────────────────────────────────────────────

test('connect sends the super to Procore with this app\'s client id, redirect and a fresh state', async () => {
  const res = await connectHandler(request());
  assert.equal(res.status, 302);
  const to = new URL(res.headers.Location);
  assert.equal(to.origin + to.pathname, 'https://login.procore.com/oauth/authorize');
  assert.equal(to.searchParams.get('response_type'), 'code');
  assert.equal(to.searchParams.get('client_id'), 'client-id');
  assert.equal(to.searchParams.get('redirect_uri'), process.env.PROCORE_REDIRECT_URI);
  const stateCookie = res.cookies.find((c) => c.name === session.STATE_COOKIE);
  assert.ok(stateCookie.httpOnly && stateCookie.secure);
  assert.equal(session.ownerFromState(stateCookie.value, to.searchParams.get('state'), Date.now()), OWNER);
});

async function startConnect(owner = OWNER) {
  const res = await connectHandler(request({ owner }));
  const state = new URL(res.headers.Location).searchParams.get('state');
  const sealed = res.cookies.find((c) => c.name === session.STATE_COOKIE).value;
  return { state, stateCookie: `${session.STATE_COOKIE}=${sealed}` };
}

test('the callback swaps the code for the super\'s token and binds the session to them', async () => {
  const { state, stateCookie } = await startConnect();
  const calls = mockFetch((c) =>
    c.path === '/oauth/token'
      ? reply(200, { access_token: 'cory-token', refresh_token: 'never-kept', expires_in: 7200 })
      : reply(200, { id: 4410, name: 'Cory Zilisch', login: 'cory@buffalo.example' }),
  );

  // Arrives from procore.com, so the platform may not have passed the Entra sign-in.
  const res = await callbackHandler(request({ owner: null, cookie: stateCookie, query: { code: 'one-use', state } }), ctx);

  assert.equal(res.status, 200);
  const exchange = JSON.parse(calls[0].body);
  assert.deepEqual(
    { grant_type: exchange.grant_type, code: exchange.code, redirect_uri: exchange.redirect_uri },
    { grant_type: 'authorization_code', code: 'one-use', redirect_uri: process.env.PROCORE_REDIRECT_URI },
  );
  assert.equal(calls[1].headers.Authorization, 'Bearer cory-token', '/me is asked as the super');

  const cookie = res.cookies.find((c) => c.name === session.SESSION_COOKIE);
  assert.ok(cookie.httpOnly && cookie.secure, 'the token is unreadable to page scripts');
  const stored = session.unseal(cookie.value);
  assert.equal(stored.owner, OWNER);
  assert.equal(stored.name, 'Cory Zilisch');
  assert.ok(!JSON.stringify(stored).includes('never-kept'), 'the refresh token is not stored');
  assert.ok(!res.body.includes('cory-token'), 'the token never reaches the page');
});

test('when /me carries no name, the callback asks the company directory for it', async () => {
  const { state, stateCookie } = await startConnect();
  const calls = mockFetch((c) =>
    c.path === '/oauth/token'
      ? reply(200, { access_token: 'cory-token', expires_in: 7200 })
      : c.path === '/rest/v1.0/me'
        ? reply(200, { id: 4410, name: '' })
        : reply(200, { id: 4410, first_name: 'Cory', last_name: 'Zilisch', email_address: 'cory@buffalo.example' }),
  );
  const res = await callbackHandler(request({ owner: null, cookie: stateCookie, query: { code: 'c', state } }), ctx);
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.method === 'GET' && c.path === `/rest/v1.0/companies/${process.env.PROCORE_COMPANY_ID}/users/4410`));
  const stored = session.unseal(res.cookies.find((c) => c.name === session.SESSION_COOKIE).value);
  assert.equal(stored.name, 'Cory Zilisch');
  assert.equal(stored.login, 'cory@buffalo.example');
  assert.match(res.body, /Connected to Procore as Cory Zilisch/);
});

test('a directory lookup that fails still connects, named by login if Procore gave one', async () => {
  const { state, stateCookie } = await startConnect();
  mockFetch((c) =>
    c.path === '/oauth/token'
      ? reply(200, { access_token: 'cory-token', expires_in: 7200 })
      : c.path === '/rest/v1.0/me'
        ? reply(200, { id: 4410, login: 'cory@buffalo.example' })
        : reply(403, { errors: 'forbidden' }),
  );
  const res = await callbackHandler(request({ owner: null, cookie: stateCookie, query: { code: 'c', state } }), ctx);
  assert.equal(res.status, 200);
  const stored = session.unseal(res.cookies.find((c) => c.name === session.SESSION_COOKIE).value);
  assert.equal(stored.name, 'cory@buffalo.example');
});

test('a callback with a forged or missing state creates nothing and never calls Procore', async () => {
  const { stateCookie } = await startConnect();
  const calls = mockFetch(() => reply(200, { access_token: 'x' }));
  for (const query of [{ code: 'c', state: 'forged' }, { code: 'c' }]) {
    const res = await callbackHandler(request({ owner: null, cookie: stateCookie, query }), ctx);
    assert.equal(res.status, 400);
    assert.ok(!res.cookies.some((c) => c.name === session.SESSION_COOKIE && c.value));
  }
  const noCookie = await callbackHandler(request({ owner: null, query: { code: 'c', state: 'x' } }), ctx);
  assert.equal(noCookie.status, 400);
  assert.equal(calls.length, 0);
});

test('a callback started by one Buffalo account cannot finish in another\'s session', async () => {
  const { state, stateCookie } = await startConnect(OWNER);
  const calls = mockFetch(() => reply(200, { access_token: 'x' }));
  const res = await callbackHandler(request({ owner: 'someone-else', cookie: stateCookie, query: { code: 'c', state } }), ctx);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

// ── Pushing as the super ─────────────────────────────────────────────────────

const pushRoute = guarded('push', pushHandler);
const item = (id) => ({ clientId: id, name: `Item ${id}`, punchItemManagerId: 4410 });

test('a push with no Procore connection is refused before anything is written', async () => {
  const calls = mockFetch(() => reply(200, { id: 1 }));
  const res = await pushRoute(request({ body: { projectId: 1, items: [item('a')] } }), ctx);
  assert.equal(res.status, 401);
  assert.equal(res.jsonBody.procoreConnect, true);
  assert.equal(calls.length, 0);
});

test('a token expiring mid-push stops it: later items are never sent into the 401', async () => {
  let posts = 0;
  const calls = mockFetch((c) => {
    if (c.method === 'POST') return ++posts === 1 ? reply(200, { id: 7 }) : reply(401, {});
    return reply(200, { id: 7, workflow_status: 'draft' });
  });
  const res = await pushRoute(request({ cookie: cookieFor(superSession()), body: { projectId: 1, items: ['a', 'b', 'c', 'd'].map(item) } }), ctx);

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.createdAs, 'Cory Zilisch');
  assert.deepEqual(res.jsonBody.results.map((r) => (r.ok ? 'ok' : r.procoreConnect ? 'reconnect' : 'other')), ['ok', 'reconnect', 'reconnect', 'reconnect']);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 2, 'items c and d were never sent');
  for (const c of calls) assert.equal(c.headers.Authorization, 'Bearer cory-token');
});

test('an expired login during the project config load asks to reconnect, not "empty dropdowns"', async () => {
  const { getProjectPunchConfig } = await import('../dist/lib/procore.js');
  clearCache();
  mockFetch(() => reply(401, {}));
  await assert.rejects(
    session.runAsProcoreUser(superSession(), () => getProjectPunchConfig(603781)),
    (err) => err.name === 'ProcoreConnectRequired',
  );
});

// ── "Not configured" names what to fix ───────────────────────────────────────

test('a misconfigured deployment names each problem setting, and never a value', async () => {
  const { procoreSettingProblems, procoreConfigured } = await import('../dist/lib/procore.js');
  const saved = { ...process.env };
  try {
    assert.deepEqual(procoreSettingProblems(), [], 'the test settings are complete');
    assert.equal(procoreConfigured(), true);

    process.env.PROCORE_SESSION_KEY = 'short-secret-value';
    process.env.PROCORE_REDIRECT_URI = 'https://app.example/api/procore/callback/';
    process.env.PROCORE_CLIENT_SECRET = 'the-secret ';
    delete process.env.PROCORE_CLIENT_ID;
    const problems = procoreSettingProblems();

    assert.ok(problems.includes('PROCORE_CLIENT_ID is not set'));
    assert.ok(problems.includes('PROCORE_SESSION_KEY is 18 characters; it needs at least 32'));
    assert.ok(problems.some((p) => p.startsWith('PROCORE_REDIRECT_URI must be')), 'a trailing slash breaks the exact match');
    assert.ok(problems.includes('PROCORE_CLIENT_SECRET has a space at the start or end'));
    assert.equal(procoreConfigured(), false);
    const text = problems.join(' ');
    for (const secret of ['short-secret-value', 'the-secret']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  } finally {
    process.env = saved;
  }
});
