import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 2026-10-01: one import put ~350 emails in front of every sub on a project.
 *
 * The super had ticked "send to the punch item manager". Sending is what moves
 * an item out of Draft, and leaving Draft is what notifies the manager, the
 * assignees and their companies. Two things made one tick worse than one email
 * per item: writes were retried after Procore may already have performed them,
 * and the send step tried up to three different send methods per item.
 *
 * Sending is now gone from the app. Items are created as Drafts and the super
 * sends them from Procore. These tests hold that line, because a send that
 * creeps back in looks exactly like a feature.
 */

process.env.PROCORE_CLIENT_ID = 'id';
process.env.PROCORE_CLIENT_SECRET = 'secret';
process.env.PROCORE_COMPANY_ID = '18895';
process.env.PROCORE_REDIRECT_URI = 'https://app.example/api/procore/callback';
process.env.PROCORE_SESSION_KEY = 'test-session-key-that-is-at-least-32-chars';


// Every Procore call runs as a connected superintendent now; there is no
// service-account token. These tests are about rate limits and write safety,
// so they run as one.
const { runAsProcoreUser } = await import('../dist/lib/procore-session.js');
const TEST_SUPER = { accessToken: 'user-token', expiresAt: Date.now() + 3_600_000, owner: 'entra-oid', procoreUserId: 42, name: 'Test Super', login: 'super@example.com' };
const asSuper = (fn) => (...args) => runAsProcoreUser(TEST_SUPER, () => fn(...args));
const procoreRequest = asSuper((await import('../dist/lib/procore.js')).procoreRequest);
const pushHandler = asSuper((await import('../dist/functions/push.js')).pushHandler);

const realFetch = globalThis.fetch;

/** Route Procore calls to `handler`; the token mint always succeeds. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/oauth/token') {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 7200 }), { status: 200 });
    }
    const body = typeof init.body === 'string' ? init.body : '';
    const call = { method: init.method || 'GET', path: u.pathname, body, form: init.body instanceof FormData ? init.body : null };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
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

const signedIn = (body) => ({
  text: async () => JSON.stringify(body),
  headers: { get: () => null },
});
const ctx = { log() {}, error() {}, warn() {} };

test('a push from a stale page asking to send is refused before anything is written', async () => {
  const calls = mockFetch(() => ok({ id: 1 }));
  const res = await pushHandler(
    signedIn({
      projectId: 1,
      send: true,
      items: [{ clientId: 'a', name: 'Cracked tile', punchItemManagerId: 4410 }],
    }),
    ctx,
  );
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('a push creates the item and makes no send write of any kind', async () => {
  const calls = mockFetch((c) => {
    if (c.method === 'POST' && c.path === '/rest/v1.1/punch_items') return ok({ id: 7 });
    // Read-back: a Draft that already holds its assignee, as Procore stores it.
    return ok({
      id: 7,
      status: 'Open',
      workflow_status: 'draft',
      assignments: [{ login_information: { name: 'Mike' } }],
    });
  });
  const res = await pushHandler(
    signedIn({
      projectId: 1,
      items: [
        {
          clientId: 'a',
          name: 'Cracked tile',
          punchItemManagerId: 4410,
          assigneeIds: [11921505],
          vendorId: 10263673,
        },
      ],
    }),
    ctx,
  );
  assert.equal(res.jsonBody.created, 1);

  const writes = calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(
    writes.map((w) => `${w.method} ${w.path}`),
    ['POST /rest/v1.1/punch_items'],
  );
  for (const c of calls) {
    assert.ok(!/\/send\b/.test(c.path), `send endpoint called: ${c.path}`);
  }
  // The only workflow state this app ever writes is Draft, on the create.
  const sent = JSON.parse(writes[0].body);
  assert.equal(sent.punch_item.workflow_status, 'draft');
  assert.deepEqual(sent.punch_item.distribution_member_ids, []);
});

test('a create with photos asks for Draft and an empty distribution list in the form too', async () => {
  const calls = mockFetch((c) => {
    if (c.method === 'POST') return ok({ id: 7, workflow_status: 'draft' });
    return ok({ id: 7, workflow_status: 'draft', has_attachments: true, attachments: [{ id: 1 }], distribution_members: [] });
  });
  const photo = 'data:image/jpeg;base64,' + Buffer.from('jpeg').toString('base64');
  await pushHandler(
    signedIn({ projectId: 1, items: [{ clientId: 'a', name: 'Cracked tile', punchItemManagerId: 4410, dueDate: '2026-11-01', photos: [photo] }] }),
    ctx,
  );
  const form = calls.find((c) => c.method === 'POST').form;
  assert.equal(form.get('punch_item[workflow_status]'), 'draft');
  assert.deepEqual(form.getAll('punch_item[distribution_member_ids][]'), [''], 'an explicit empty list, not an omitted one');
  assert.equal(form.get('punch_item[due]'), '2026-11-01', 'the request key is due, not due_date');
  assert.equal(form.get('punch_item[due_date]'), null);
});

test('an item that comes back initiated with an empty distribution list does not stop the push', async () => {
  // Cory, 2026-10-14: Initiated is acceptable. Item Created emails the
  // distribution group either way, so the list is what is guarded, not Draft.
  let posts = 0;
  const calls = mockFetch((c) => {
    if (c.method === 'POST') return ok({ id: 100 + ++posts, workflow_status: 'initiated' });
    return ok({ id: 101, status: 'Open', workflow_status: 'initiated', distribution_members: [] });
  });
  const res = await pushHandler(
    signedIn({ projectId: 1, items: ['a', 'b', 'c'].map((clientId) => ({ clientId, name: `Item ${clientId}`, punchItemManagerId: 4410 })) }),
    ctx,
  );
  assert.equal(calls.filter((c) => c.method === 'POST').length, 3);
  assert.equal(res.jsonBody.safetyStop, undefined);
  assert.deepEqual(res.jsonBody.results.map((r) => r.ok), [true, true, true]);
});

for (const [why, readBack, pattern] of [
  ['has people on its distribution list', { workflow_status: 'initiated', distribution_members: [{ id: 1, name: 'Dana Sub' }] }, /Dana Sub/],
  ['cannot be read back', null, /could not be read back/],
]) {
  test(`an item that ${why} stops the push: nothing after it is sent`, async () => {
    let posts = 0;
    const calls = mockFetch((c) => {
      if (c.method === 'POST') return ok({ id: 100 + ++posts, workflow_status: 'initiated' });
      if (!readBack) return new Response('{}', { status: 404 });
      return ok({ id: 101, status: 'Open', ...readBack });
    });
    const res = await pushHandler(
      signedIn({
        projectId: 1,
        items: ['a', 'b', 'c'].map((clientId) => ({ clientId, name: `Item ${clientId}`, punchItemManagerId: 4410 })),
      }),
      ctx,
    );
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'one item, then stop');
    assert.match(res.jsonBody.safetyStop.reason, pattern);
    assert.deepEqual(res.jsonBody.results.map((r) => r.ok), [true, false, false]);
    assert.ok(res.jsonBody.results.slice(1).every((r) => r.safetyStopped));
  });
}

test('a push with an item missing its punch item manager is refused before anything is written', async () => {
  // The whole batch, not just the bad row: refusing before any write is what
  // lets the dashboard treat this as "nothing was created, fix and push again".
  const calls = mockFetch(() => ok({ id: 1 }));
  const res = await pushHandler(
    signedIn({
      projectId: 1,
      items: [
        { clientId: 'a', name: 'Cracked tile', punchItemManagerId: 4410 },
        { clientId: 'b', name: 'Paint touch up' },
        { clientId: 'c', name: 'Caulk grid to wall', punchItemManagerId: '' },
      ],
    }),
    ctx,
  );
  assert.equal(res.status, 400);
  assert.match(res.jsonBody.error, /2 item\(s\) have no punch item manager/);
  assert.equal(calls.length, 0);
});

test('a dry run without a punch item manager still previews', async () => {
  const res = await pushHandler(
    signedIn({ projectId: 1, dryRun: true, items: [{ clientId: 'a', name: 'Cracked tile' }] }),
    ctx,
  );
  assert.equal(res.status ?? 200, 200);
  assert.equal(res.jsonBody.results.length, 1);
});

test('an assignee that does not show on read-back gets no second write', async () => {
  // The assignee chain made up to three writes per item after the create. It is
  // gone: a missing assignee is reported for the super to set in Procore.
  const calls = mockFetch((c) => {
    if (c.method === 'POST' && c.path === '/rest/v1.1/punch_items') return ok({ id: 7, workflow_status: 'draft' });
    return ok({ id: 7, status: 'Open', workflow_status: 'draft', has_attachments: false, attachments: [] });
  });
  const res = await pushHandler(
    signedIn({ projectId: 1, items: [{ clientId: 'a', name: 'Cracked tile', punchItemManagerId: 4410, assigneeIds: [11921505] }] }),
    ctx,
  );
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ['POST /rest/v1.1/punch_items'], 'exactly one write');
  const r = res.jsonBody.results[0];
  assert.match(r.assignErrors.join(' '), /Set the assignee in Procore/);
  assert.deepEqual(r.draftTrail.map((t) => `${t.step}:${t.label}`), ['create response:draft', 'read-back:draft']);
});

test('photos the create dropped get one attachments PATCH, never a send, and the trail records it', async () => {
  // 2026-10-14: with the create as the only write, 0 of 12 photos landed. The
  // create response already said initiated, so the PATCH was not the cause.
  let patched = false;
  const calls = mockFetch((c) => {
    if (c.method === 'POST' && c.path === '/rest/v1.1/punch_items') return ok({ id: 7, workflow_status: 'initiated' });
    if (c.method === 'PATCH') {
      patched = true;
      return ok({ id: 7 });
    }
    return ok({
      id: 7,
      status: 'Open',
      workflow_status: 'initiated',
      has_attachments: patched,
      attachments: patched ? [{ id: 1, name: 'p.jpg' }] : [],
    });
  });
  const photo = 'data:image/jpeg;base64,' + Buffer.from('jpeg').toString('base64');
  const res = await pushHandler(
    signedIn({ projectId: 1, items: [{ clientId: 'a', name: 'Cracked tile', punchItemManagerId: 4410, photos: [photo] }] }),
    ctx,
  );
  const writes = calls.filter((c) => c.method !== 'GET');
  assert.deepEqual(
    writes.map((w) => `${w.method} ${w.path}`),
    ['POST /rest/v1.1/punch_items', 'PATCH /rest/v1.1/punch_items/7'],
  );
  assert.ok(!calls.some((c) => /\/send\b/.test(c.path)));
  const r = res.jsonBody.results[0];
  assert.equal(r.photosAttached, 1);
  assert.ok(!r.photoErrors?.length);
  assert.deepEqual(r.draftTrail.map((t) => t.step), ['create response', 'read-back', 'after photos']);
});
