import test from 'node:test';
import assert from 'node:assert/strict';

import { guestReason, graphGuestReason, principalOid, rejectedResponse, registerGuestGate, _resetGraphCache } from '../dist/lib/guest-gate.js';

// A guest account is refused on every route (Nov 2026). Principal fixtures in
// the shape SWA's x-ms-client-principal takes for the custom Entra provider.
const TID = '765713ef-2ac8-4410-98f0-08ea9552c506';
const OID = '8f2c1a4e-0d3b-4c7e-9a1f-2b5d6e7f8a90';
const principal = (claims, userDetails = 'dana.reed@buffaloconstruction.com') => ({
  identityProvider: 'aad', userId: 'swa-generated', userDetails, userRoles: ['authenticated'],
  claims: Object.entries(claims).map(([typ, val]) => ({ typ, val })),
});
const MEMBER = {
  'http://schemas.microsoft.com/identity/claims/objectidentifier': OID,
  'http://schemas.microsoft.com/identity/claims/tenantid': TID,
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name': 'Dana Reed',
  preferred_username: 'dana.reed@buffaloconstruction.com',
};

test('a member of the tenant passes the claims check', () => {
  assert.equal(guestReason(principal(MEMBER)), null);
  assert.equal(guestReason(principal({ ...MEMBER, idp: `https://sts.windows.net/${TID}/` })), null);
  assert.equal(guestReason(principal({ ...MEMBER, idp: `https://login.microsoftonline.com/${TID}/v2.0` })), null);
});

test('a B2B guest is refused by idp, by a #EXT# name, or by acct', () => {
  assert.equal(guestReason(principal({ ...MEMBER, 'http://schemas.microsoft.com/identity/claims/identityprovider': 'https://sts.windows.net/11111111-2222-3333-4444-555555555555/' })), 'external-idp');
  assert.equal(guestReason(principal({ ...MEMBER, upn: 'arch_designfirm.com#EXT#@buffaloconstruction.onmicrosoft.com' })), 'ext-upn');
  assert.equal(guestReason(principal(MEMBER, 'arch_designfirm.com#EXT#@buffaloconstruction.onmicrosoft.com')), 'ext-upn');
  assert.equal(guestReason(principal({ ...MEMBER, idp: 'live.com' })), 'external-idp');
  assert.equal(guestReason(principal({ ...MEMBER, idp: 'mail' })), 'external-idp');
  assert.equal(guestReason(principal({ ...MEMBER, acct: '1' })), 'acct-guest');
  assert.equal(guestReason(principal({ ...MEMBER, acct: '0' })), null);
});

test('no principal (a key-authenticated machine caller) is not a guest', () => {
  assert.equal(guestReason(null), null);
  assert.equal(guestReason({}), null);
});

test('the oid comes from the objectidentifier claim, never from SWA userId', () => {
  assert.equal(principalOid(principal(MEMBER)), OID);
  assert.equal(principalOid({ userId: 'swa-generated', claims: [] }), null);
});

test('Graph says Guest: refused, whatever the claims look like', async () => {
  _resetGraphCache();
  assert.equal(await graphGuestReason(principal(MEMBER), { fetchUserType: async () => 'Guest' }), 'graph-guest');
  _resetGraphCache();
  assert.equal(await graphGuestReason(principal(MEMBER), { fetchUserType: async () => 'Member' }), null);
});

test('the verdict is cached per oid for an hour', async () => {
  _resetGraphCache();
  let calls = 0; let t = 1_000_000;
  const deps = { fetchUserType: async () => { calls++; return 'Guest'; }, now: () => t };
  await graphGuestReason(principal(MEMBER), deps);
  await graphGuestReason(principal(MEMBER), deps);
  assert.equal(calls, 1);
  t += 61 * 60 * 1000;
  await graphGuestReason(principal(MEMBER), deps);
  assert.equal(calls, 2);
});

test('a Graph failure fails open, is logged, and is retried after five minutes', async () => {
  _resetGraphCache();
  let calls = 0; let t = 1_000_000; const warned = [];
  const deps = { fetchUserType: async () => { calls++; throw new Error('Graph 403'); }, now: () => t, warn: (m) => warned.push(m) };
  assert.equal(await graphGuestReason(principal(MEMBER), deps), null);
  assert.equal(await graphGuestReason(principal(MEMBER), deps), null);
  assert.equal(calls, 1);
  assert.match(warned[0], /Graph 403/);
  t += 6 * 60 * 1000;
  await graphGuestReason(principal(MEMBER), deps);
  assert.equal(calls, 2);
});

test('the refusal is a 403 the page can recognise', () => {
  const r = rejectedResponse('The Punch List Assistant');
  assert.equal(r.status, 403);
  assert.equal(r.jsonBody.error, 'guest');
  assert.match(r.jsonBody.message, /^The Punch List Assistant is for Buffalo employees/);
  assert.equal(r.headers['Cache-Control'], 'no-store');
});

test('the hook replaces the handler for a guest and leaves a member alone', async () => {
  _resetGraphCache();
  let hook;
  registerGuestGate({ hook: { preInvocation: (h) => { hook = h; } } }, 'The Punch List Assistant');
  const header = (p) => Buffer.from(JSON.stringify(p)).toString('base64');
  const ctxFor = (p) => {
    const warned = [];
    return {
      warned,
      inputs: [{ method: 'GET', url: 'https://x.test/api/me', headers: { get: (k) => (k === 'x-ms-client-principal' && p ? header(p) : null) } }],
      invocationContext: { warn: (m) => warned.push(m) },
      functionHandler: async () => ({ status: 200 }),
    };
  };
  const guest = ctxFor(principal({ ...MEMBER, idp: 'live.com' }));
  await hook(guest);
  assert.equal((await guest.functionHandler()).status, 403);
  assert.match(guest.warned[0], /guest account refused: GET \/api\/me \(external-idp; claims: /);
  assert.ok(!guest.warned[0].includes('live.com'), 'claim values never reach the log');
  const machine = ctxFor(null);
  await hook(machine);
  assert.equal((await machine.functionHandler()).status, 200);
});
