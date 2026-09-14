import test from 'node:test';
import assert from 'node:assert/strict';

import { guarded, getPrincipal } from '../dist/lib/http.js';

/**
 * The bug this exists to prevent recurring.
 *
 * `staticwebapp.config.json` required `allowedRoles: ["authenticated"]` on
 * `/*` and `/api/*` — and sat at the repo ROOT while the workflow deploys
 * `app_location: ./dashboard`. SWA reads that file from the deployed app
 * folder, so it was never applied: the dashboard and every API route, including
 * the ones that write into live Procore projects, were open to anyone with the
 * URL. Nothing failed, nothing logged, and the repo's own docs said the app was
 * gated.
 *
 * So the gate is asserted in code too. A config file in the wrong folder cannot
 * turn this off.
 */

const req = (headers = {}) => ({
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

const ctx = { error() {}, warn() {} };

const principalHeader = (userDetails) =>
  Buffer.from(
    JSON.stringify({
      userId: 'abc',
      userDetails,
      identityProvider: 'aad',
      userRoles: ['authenticated'],
    }),
  ).toString('base64');

test('a request with no principal is refused, and the handler never runs', async () => {
  let ran = false;
  const fn = guarded('test', async () => {
    ran = true;
    return { status: 200 };
  });

  const res = await fn(req(), ctx);
  assert.equal(res.status, 401);
  assert.equal(ran, false, 'the handler must not run for an anonymous caller');
  assert.match(res.jsonBody.error, /not signed in/i);
  assert.equal(res.jsonBody.signInUrl, '/.auth/login/aad');
});

test('a signed-in request reaches the handler', async () => {
  const fn = guarded('test', async () => ({ status: 200, jsonBody: { ok: true } }));
  const res = await fn(
    req({ 'x-ms-client-principal': principalHeader('cory.zilisch@buffaloconstruction.com') }),
    ctx,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.jsonBody, { ok: true });
});

/**
 * A malformed or empty principal must read as "nobody", not as "someone".
 * Anything that parses to a principal without an identity is a header we do not
 * understand, and the safe way to be wrong about that is to refuse.
 */
test('a junk or identity-less principal header is not an identity', async () => {
  for (const header of [
    'not-base64-at-all',
    Buffer.from('{"userId":"x"}').toString('base64'), // no userDetails
    Buffer.from('{}').toString('base64'),
    Buffer.from('null').toString('base64'),
    '',
  ]) {
    assert.equal(getPrincipal(req({ 'x-ms-client-principal': header })), null, `accepted: ${header}`);
  }
});

/** An unexpected throw must still be described, not become a bare 500. */
test('a signed-in request that throws is still reported with its message', async () => {
  const fn = guarded('boom', async () => {
    throw new Error('kaboom');
  });
  const res = await fn(req({ 'x-ms-client-principal': principalHeader('a@b.com') }), ctx);
  assert.equal(res.status, 500);
  assert.match(res.jsonBody.error, /kaboom/);
});
