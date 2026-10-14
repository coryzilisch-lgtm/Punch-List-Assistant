/**
 * The push against Procore's rate limit, driven through the real dashboard.
 *
 * On the 228-item Darden import (2026-10-12) the quota ran out after 147 items
 * and the dashboard kept going: batch after batch drew the same 429 until 78
 * more items had failed, and a second attempt walked into the same wall with no
 * warning. These tests hold the two things that fixes it:
 *
 *  - a push plans against the quota: it creates what fits and stops, and the
 *    button says so before it is pressed;
 *  - a push stops at the first rate-limited batch instead of sending the rest
 *    into it, and leaves everything not created selected.
 *
 * Everything runs through the real UI: pick the project, upload a PDF, set the
 * manager and final approver, press Create. Only `/api/*` is stubbed.
 *
 *   node tools/dashboard-test/push-quota.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DASHBOARD = path.resolve(fileURLToPath(new URL('../../dashboard', import.meta.url)));
const ITEMS = 12;

function serve() {
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
  const server = http.createServer((req, res) => {
    const rel = req.url.split('?')[0];
    const file = path.join(DASHBOARD, rel === '/' ? '/index.html' : rel);
    if (!file.startsWith(DASHBOARD) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port })));
}

/** A valid one-page PDF, built here so no client's document ends up in the repo. */
function onePagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const CONFIG = {
  users: [
    { id: 4410, name: 'Pat Manager', company: 'Buffalo Construction Inc.', email: 'pat@buffaloconstruction.com' },
    { id: 5520, name: 'Test Super', company: 'Buffalo Construction Inc.', email: 'test@buffaloconstruction.com' },
  ],
  vendors: [],
  trades: [],
  punchItemTypes: [],
  locations: [],
};

const quota = (over) => ({ limit: 3600, remaining: 3000, resetAt: Date.now() + 40 * 60_000, capacity: 900, perItem: 3, reserve: 200, ...over });

let shared = null;
async function harness() {
  if (!shared) {
    const { server, port } = await serve();
    shared = { server, port, browser: await chromium.launch() };
  }
  return shared;
}
test.after(async () => {
  if (!shared) return;
  await shared.browser.close();
  shared.server.close();
});

/**
 * Walk the real UI to the Create step with `ITEMS` items, every one with a
 * manager, then hand over. `onPush(body, n)` answers each /api/push call.
 */
/** A super who has connected Procore, unless a test says otherwise. */
const CONNECTED = () => ({
  email: 'test@buffaloconstruction.com',
  procore: { configured: true, connected: true, name: 'Test Super', procoreUserId: 5520, expiresAt: Date.now() + 3_600_000 },
});

async function openApp({ quotaReply = quota(), onPush = () => ({ json: { results: [] } }), meReply = CONNECTED, extraRoutes = {} } = {}) {
  const { browser, port } = await harness();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const pushes = [];
  const quotaCalls = [];

  // On the context, not the page, so the Procore connect popup is routed too.
  await page.context().route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const send = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (extraRoutes[url.pathname]) return extraRoutes[url.pathname](route);
    switch (url.pathname) {
      case '/api/me':
        return send(meReply());
      case '/api/projects':
        return send({ projects: [{ id: 1, name: 'Test Job' }], source: 'stub' });
      case '/api/probe':
        return send({ checks: [], config: CONFIG });
      case '/api/extract':
        return send({
          page_kind: 'items',
          items: Array.from({ length: ITEMS }, (_, i) => ({ source_number: String(i + 1), title: `Item ${i + 1}`, confidence: 'high', photo_indexes: [] })),
        });
      case '/api/quota':
        quotaCalls.push(Date.now());
        return send(typeof quotaReply === 'function' ? quotaReply() : quotaReply);
      case '/api/push': {
        const body = JSON.parse(route.request().postData());
        pushes.push(body);
        const { status = 200, json } = onPush(body, pushes.length);
        return send(json, status);
      }
      default:
        return send({});
    }
  });

  await page.goto(`http://127.0.0.1:${port}/index.html?project_id=1`, { waitUntil: 'networkidle' });
  return { page, pushes, errors, quotaCalls, port };
}

async function toCreateStep(opts) {
  const { page, pushes, errors, quotaCalls } = await openApp(opts);
  await page.waitForFunction(() => !document.getElementById('next-btn').disabled);
  await page.click('#next-btn'); // → upload

  await page.setInputFiles('#file-input', { name: 'list.pdf', mimeType: 'application/pdf', buffer: onePagePdf() });
  await page.waitForFunction(() => !document.getElementById('next-btn').disabled, null, { timeout: 20_000 });
  await page.click('#next-btn'); // → review

  // The two questions at the top of the review step, answered "Me".
  await page.check('input[name="role-punchItemManagerId"][value="me"]');
  await page.check('input[name="role-finalApproverId"][value="me"]');

  await page.click('#next-btn'); // → create
  await page.waitForFunction(() => document.getElementById('send-summary').textContent.includes('rate limit') || document.getElementById('send-summary').textContent.includes('Drafts'));
  return { page, pushes, errors, quotaCalls };
}

const created = (body, firstId = 100) => ({
  json: {
    results: body.items.map((it, i) => ({ clientId: it.clientId, ok: true, punchItemId: firstId + i, observed: { isDraft: true } })),
    quota: null,
  },
});

test('a push the quota cannot fully carry creates what fits and stops', async () => {
  // Room for 7 of 12: one batch of 5, then one of 2, then stop.
  let capacity = 7;
  const { page, pushes, errors } = await toCreateStep({
    quotaReply: quota({ capacity }),
    onPush: (body) => {
      capacity -= body.items.length;
      const r = created(body);
      r.json.quota = quota({ capacity });
      return r;
    },
  });
  try {
    await page.waitForFunction(() => /Create 7 of 12/.test(document.getElementById('next-btn').textContent));
    assert.match(await page.textContent('#send-summary'), /create the first 7 item\(s\) and stop/);
    // A reset 40 minutes out means the headers have switched to the hourly limit.
    assert.match(await page.textContent('#send-summary'), /reporting its hourly limit/);

    await page.click('#next-btn');
    await page.waitForFunction(() => document.getElementById('results').textContent.includes('Stopped'));

    // The first item goes alone (the safety catch), then batches of five.
    assert.deepEqual(pushes.map((p) => p.items.length), [1, 5, 1], 'nothing past the quota');
    const results = await page.textContent('#results');
    assert.match(results, /7 punch items created/);
    assert.match(results, /5 items were not created/);
    // The five not created are still selected, and the quota now has no room.
    assert.match(await page.textContent('#next-btn'), /Create 0 of 5 punch items/);
    assert.ok(await page.isDisabled('#next-btn'));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a push with no quota room does not start', async () => {
  const { page, pushes, errors } = await toCreateStep({
    quotaReply: quota({ remaining: 150, capacity: 0 }),
    onPush: created,
  });
  try {
    await page.waitForFunction(() => document.getElementById('next-btn').disabled);
    assert.match(await page.textContent('#send-summary'), /Not enough Procore quota/);
    assert.equal(pushes.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a rate-limited batch stops the push; later batches are never sent', async () => {
  // Quota unknown (Procore sent no headers), so nothing is planned up front:
  // the first batch lands, the second comes back rate limited, the third must
  // not be sent. On the Darden import it was, eleven times over. (Push 1 is the
  // first item alone, so the batches are 1, 5, 5, 1.)
  const resetAt = Date.now() + 30 * 60_000;
  const { page, pushes, errors } = await toCreateStep({
    quotaReply: quota({ limit: null, remaining: null, resetAt: null, capacity: null }),
    onPush: (body, n) =>
      n <= 2
        ? created(body)
        : {
            json: {
              results: body.items.map((it, i) =>
                i === 0
                  ? { clientId: it.clientId, ok: true, punchItemId: 900, observed: { isDraft: true } }
                  : { clientId: it.clientId, ok: false, rateLimited: true, resetAt, error: 'Procore rejected this item (HTTP 429).' },
              ),
              quota: null,
            },
          },
  });
  try {
    await page.click('#next-btn');
    await page.waitForFunction(() => document.getElementById('results').textContent.includes('Stopped'));

    assert.equal(pushes.length, 3, 'the last batch was never sent');
    const results = await page.textContent('#results');
    assert.match(results, /7 punch items created/);
    // 4 refused in the rate-limited batch + 1 never attempted.
    assert.match(results, /5 items were not created/);
    assert.match(await page.textContent('#next-btn'), /Create 5 punch items/, 'all five not created stay selected');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// ── The tenant's real window: 25 requests, resetting in seconds ─────────────

test('the tenant\'s 25-request window: the button is not capped and the push waits through resets', async () => {
  // 2026-10-13: Procore reported "23 of 25 requests left". The first version
  // reserved 200 requests for the ingest, computed room for 0 items, and
  // refused to push anything at all.
  const window = () => ({ limit: 25, remaining: 23, resetAt: Date.now() + 2_000, capacity: 7, perItem: 3, reserve: 2 });
  const { page, pushes, errors } = await toCreateStep({
    quotaReply: window,
    onPush: (body) => {
      const r = created(body);
      // Each batch spends the window; it resets two seconds later.
      r.json.quota = { ...window(), remaining: 3, capacity: 0 };
      return r;
    },
  });
  try {
    await page.waitForFunction(() => /^Create 12 punch items$/.test(document.getElementById('next-btn').textContent.trim()));
    assert.ok(!(await page.isDisabled('#next-btn')));
    assert.match(await page.textContent('#send-summary'), /paces itself/);
    assert.doesNotMatch(await page.textContent('#send-summary'), /Not enough Procore quota/);

    await page.click('#next-btn');
    await page.waitForFunction(() => /12 punch items created/.test(document.getElementById('results').textContent), null, { timeout: 30_000 });

    assert.deepEqual(pushes.map((p) => p.items.length), [1, 5, 5, 1], 'paced batches, every item sent once');
    assert.doesNotMatch(await page.textContent('#results'), /Stopped/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('items refused by a window that resets in seconds are retried, not dropped', async () => {
  let n = 0;
  const { page, pushes, errors } = await toCreateStep({
    quotaReply: () => ({ limit: 25, remaining: 20, resetAt: Date.now() + 2_000, capacity: 6, perItem: 3, reserve: 2 }),
    onPush: (body) => {
      n += 1;
      if (n !== 2) return created(body, n * 100);
      // The first full batch (after the lone first item): two land, three hit the window. Those three were never written.
      const resetAt = Date.now() + 1_500;
      return {
        json: {
          results: body.items.map((it, i) =>
            i < 2
              ? { clientId: it.clientId, ok: true, punchItemId: 10 + i, observed: { isDraft: true } }
              : { clientId: it.clientId, ok: false, rateLimited: true, resetAt, error: 'Procore rejected this item (HTTP 429).' },
          ),
          quota: { limit: 25, remaining: 0, resetAt, capacity: 0, perItem: 3, reserve: 2 },
        },
      };
    },
  });
  try {
    await page.click('#next-btn');
    await page.waitForFunction(() => /12 punch items created/.test(document.getElementById('results').textContent), null, { timeout: 30_000 });

    const sent = pushes.flatMap((p) => p.items.map((i) => i.clientId));
    assert.equal(new Set(sent).size, 12, 'every item was sent');
    assert.equal(sent.length, 15, 'the three refused items were sent exactly twice, nothing else repeated');
    assert.doesNotMatch(await page.textContent('#results'), /Stopped|rejected/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// ── Knowing which limit it was, and what the import cost ────────────────────

test('a long-reset stop says it was the hourly-scale limit and what this import had spent', async () => {
  const resetAt = Date.now() + 38 * 60_000;
  const { page, errors } = await toCreateStep({
    quotaReply: { limit: null, remaining: null, resetAt: null, capacity: null, perItem: 3, reserve: 200, requests: 1 },
    onPush: (body, n) =>
      n <= 2
        ? { json: { ...created(body).json, requests: 5 } }
        : {
            json: {
              results: body.items.map((it) => ({ clientId: it.clientId, ok: false, rateLimited: true, resetAt, error: 'HTTP 429' })),
              requests: 1,
              quota: null,
            },
          },
  });
  try {
    await page.click('#next-btn');
    await page.waitForFunction(() => document.getElementById('results').textContent.includes('Stopped'));
    const text = await page.textContent('#results');
    assert.match(text, /long \(hourly-scale\) limit, not the burst window/);
    // 5 + 5 for the first two batches + 1 for the refused one. The quota check made on
    // opening the step is reused, not asked again, so it is not part of this push.
    assert.match(text, /This import had used 11 Procore requests/);
    assert.match(text, /used 11 Procore requests for 6 items created \(about 1\.8 each\)/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('waiting out a short window costs no extra quota checks', async () => {
  // Each /api/quota call is a Procore request. The paced push must not ask
  // after every wait; the next batch reports the quota itself.
  const window = () => ({ limit: 25, remaining: 23, resetAt: Date.now() + 2_000, capacity: 7, perItem: 3, reserve: 2, requests: 1 });
  const { page, pushes, errors, quotaCalls } = await toCreateStep({
    quotaReply: window,
    onPush: (body) => ({ json: { ...created(body).json, requests: body.items.length * 2, quota: { ...window(), remaining: 3, capacity: 0 } } }),
  });
  try {
    const before = quotaCalls.length;
    await page.click('#next-btn');
    await page.waitForFunction(() => /12 punch items created/.test(document.getElementById('results').textContent), null, { timeout: 30_000 });
    assert.ok(pushes.length >= 3, 'it paced across several windows');
    assert.ok(quotaCalls.length - before <= 1, `quota was asked ${quotaCalls.length - before} times during the push`);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// ── Creating items as the super: the Procore connection ─────────────────────

const NOT_CONNECTED = () => ({
  email: 'test@buffaloconstruction.com',
  procore: { configured: true, connected: false, name: null, expiresAt: null },
});

test('without a Procore connection, the super is asked to connect and cannot continue', async () => {
  const { page, errors } = await openApp({ meReply: NOT_CONNECTED });
  try {
    await page.waitForSelector('#procore-connect');
    assert.match(await page.textContent('#procore-card'), /Connect your Procore account/);
    assert.ok(await page.isDisabled('#next-btn'), 'project chosen, but no Procore connection');
    assert.match(await page.textContent('#readiness'), /Connect Procore above/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('connecting happens in a popup and the open tab picks it up without reloading', async () => {
  let connected = false;
  const { page, errors } = await openApp({
    meReply: () => (connected ? { ...CONNECTED(), procore: { ...CONNECTED().procore, name: 'Cory Zilisch' } } : NOT_CONNECTED()),
    extraRoutes: {
      // Stands in for Procore's login and our callback: the popup ends on the
      // callback's page, which loads the real /procore-connected.js.
      '/api/procore/connect': (route) => {
        connected = true;
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><body data-ok="true" data-message="Connected"><script src="/procore-connected.js"></script></body>',
        });
      },
    },
  });
  try {
    await page.evaluate(() => {
      window.__marker = 'same tab';
    });
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#procore-connect')]);
    await popup.waitForEvent('close');
    await page.waitForFunction(() => /connected as/.test(document.getElementById('procore-card').textContent));
    assert.match(await page.textContent('#procore-card'), /Cory Zilisch/);
    assert.equal(await page.evaluate(() => window.__marker), 'same tab', 'the tab was not reloaded');
    assert.ok(!(await page.isDisabled('#next-btn')));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a connection that expires mid-push stops it and keeps the unsent items selected', async () => {
  const { page, pushes, errors } = await toCreateStep({
    quotaReply: quota(),
    onPush: (body, n) =>
      n <= 2
        ? { json: { ...created(body).json, createdAs: 'Test Super' } }
        : {
            json: {
              results: body.items.map((it) => ({ clientId: it.clientId, ok: false, procoreConnect: true, error: 'expired' })),
              procoreConnect: true,
              quota: null,
            },
          },
  });
  try {
    await page.click('#next-btn');
    await page.waitForFunction(() => /connection expired/.test(document.getElementById('results').textContent));

    assert.equal(pushes.length, 3, 'nothing was sent after the connection was lost');
    const text = await page.textContent('#results');
    assert.match(text, /6 punch items created/);
    assert.match(text, /Created in Procore as Test Super/);
    // 5 refused in the expired batch + 1 never attempted.
    assert.match(text, /6 items were not created/);
    assert.doesNotMatch(text, /rate limit/i, 'an expired login is not reported as a rate limit');
    assert.ok(await page.isVisible('[data-act="procore-reconnect"]'));
    assert.match(await page.textContent('#next-btn'), /Create 6 punch items/, 'the six stay selected');
    assert.ok(await page.isDisabled('#next-btn'), 'until the super reconnects');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// ── Procore's login severs the popup from the tab (2026-10-14) ───────────────
//
// Procore's login page sends a Cross-Origin-Opener-Policy, so when the popup
// comes back to our origin its window.opener is null. The first version relied
// on window.opener: Cory signed in, the tab never heard, and the app loaded
// inside the popup instead. These reproduce the severing by nulling the opener
// before the callback's real script runs.

function connectingApp(callbackHtml) {
  let connected = false;
  return {
    get connected() {
      return connected;
    },
    opts: {
      meReply: () => (connected ? { ...CONNECTED(), procore: { ...CONNECTED().procore, name: 'Cory Zilisch' } } : NOT_CONNECTED()),
      extraRoutes: {
        '/api/procore/connect': (route) => {
          connected = true; // the callback set the session cookie
          return route.fulfill({ status: 200, contentType: 'text/html', body: callbackHtml });
        },
      },
    },
  };
}

const SEVERED_CALLBACK =
  '<!doctype html><body data-ok="true" data-message="Connected">' +
  '<script>window.opener = null;</script><script src="/procore-connected.js"></script></body>';

test('a popup severed from its opener still connects the original tab, and closes', async () => {
  const flow = connectingApp(SEVERED_CALLBACK);
  const { page, errors } = await openApp(flow.opts);
  try {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#procore-connect')]);
    await popup.waitForEvent('close', { timeout: 10_000 });
    await page.waitForFunction(() => /connected as/.test(document.getElementById('procore-card').textContent));
    assert.match(await page.textContent('#procore-card'), /Cory Zilisch/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('even with every message lost, returning to the tab finds the connection', async () => {
  // A callback page with no script at all: nothing is posted anywhere.
  const flow = connectingApp('<!doctype html><body data-ok="true"><p>Connected</p></body>');
  const { page, errors } = await openApp(flow.opts);
  try {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#procore-connect')]);
    await popup.waitForLoadState();
    await popup.close();
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(() => /connected as/.test(document.getElementById('procore-card').textContent));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('opened at a different address from the Procore callback, the page says where to go instead', async () => {
  // Cory opened punchass.buffaloconstruction.com while Procore returned to the
  // azurestaticapps.net name: the state cookie and the session landed on the
  // other site, and connecting could not work.
  const { page, errors } = await openApp({
    meReply: () => ({ ...NOT_CONNECTED(), procore: { ...NOT_CONNECTED().procore, callbackHost: 'punchass.example' } }),
  });
  try {
    await page.waitForFunction(() => /Open this app at punchass\.example/.test(document.getElementById('procore-card').textContent));
    assert.equal(await page.$('#procore-connect'), null, 'no Connect button that cannot work');
    assert.match(await page.getAttribute('#procore-card a', 'href'), /^https:\/\/punchass\.example\/index\.html/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('opened at the callback address, Connect is offered as normal', async () => {
  const { port } = await harness();
  const { page, errors } = await openApp({
    meReply: () => ({ ...NOT_CONNECTED(), procore: { ...NOT_CONNECTED().procore, callbackHost: `127.0.0.1:${port}` } }),
  });
  try {
    await page.waitForSelector('#procore-connect');
    assert.doesNotMatch(await page.textContent('#procore-card'), /Open this app at/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// ── Who the items answer to ──────────────────────────────────────────────────
//
// The review step opens by asking who the punch item manager and final approver
// are, "Me" or "Someone else", and does not continue until both are answered.

async function toReview(opts) {
  const ctx = await openApp(opts);
  const { page } = ctx;
  await page.waitForFunction(() => !document.getElementById('next-btn').disabled);
  await page.click('#next-btn'); // → upload
  await page.setInputFiles('#file-input', { name: 'list.pdf', mimeType: 'application/pdf', buffer: onePagePdf() });
  await page.waitForFunction(() => !document.getElementById('next-btn').disabled, null, { timeout: 20_000 });
  await page.click('#next-btn'); // → review
  await page.waitForSelector('#roles-card fieldset.role');
  return ctx;
}

/** Every item has gone to /api/push (it goes in batches). */
async function allPushed(pushes) {
  const until = Date.now() + 10_000;
  while (pushes.flatMap((p) => p.items).length < ITEMS) {
    if (Date.now() > until) throw new Error(`only ${pushes.flatMap((p) => p.items).length} of ${ITEMS} items were pushed`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const nextDisabled = (page) => page.evaluate(() => document.getElementById('next-btn').disabled);

test('the review step cannot continue until both roles are answered, and "Me" is the signed-in super', async () => {
  const { page, pushes, errors } = await toReview({ onPush: (body) => created(body) });
  try {
    assert.equal(await nextDisabled(page), true, 'nothing answered');
    assert.match(await page.textContent('#bar-summary'), /punch item manager and final approver are/);
    assert.match(await page.textContent('#roles-card'), /Me \(Test Super\)/);

    await page.check('input[name="role-punchItemManagerId"][value="me"]');
    assert.equal(await nextDisabled(page), true, 'final approver still unanswered');
    await page.check('input[name="role-finalApproverId"][value="me"]');
    assert.equal(await nextDisabled(page), false);

    await page.click('#next-btn'); // → create
    await page.waitForFunction(() => document.getElementById('send-summary').textContent.includes('Drafts'));
    await page.click('#next-btn');
    await allPushed(pushes);
    const items = pushes.flatMap((p) => p.items);
    assert.equal(items.length, ITEMS);
    for (const it of items) {
      assert.equal(it.punchItemManagerId, 5520);
      assert.equal(it.finalApproverId, 5520);
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('"Someone else" stays unanswered until a person is picked, then applies to every item', async () => {
  const { page, pushes, errors } = await toReview({ onPush: (body) => created(body) });
  try {
    await page.check('input[name="role-punchItemManagerId"][value="me"]');
    await page.check('input[name="role-finalApproverId"][value="other"]');
    assert.equal(await nextDisabled(page), true, '"Someone else" with nobody picked is not an answer');

    const combo = page.locator('input.namecombo[data-act="finalApproverId"][data-scope="role"]');
    await combo.click();
    await combo.fill('Pat');
    await page.locator('#name-popup li[data-id="4410"]').click();
    assert.equal(await nextDisabled(page), false);
    assert.equal(await combo.inputValue(), 'Pat Manager');

    await page.click('#next-btn');
    await page.waitForFunction(() => document.getElementById('send-summary').textContent.includes('Drafts'));
    await page.click('#next-btn');
    await allPushed(pushes);
    for (const it of pushes.flatMap((p) => p.items)) {
      assert.equal(it.punchItemManagerId, 5520);
      assert.equal(it.finalApproverId, 4410);
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a super who is not in the project directory cannot pick "Me", and is told why', async () => {
  const { page, errors } = await toReview({
    meReply: () => ({
      email: 'stranger@buffaloconstruction.com',
      procore: { ...CONNECTED().procore, name: 'Stranger', procoreUserId: 9999, login: 'stranger@buffaloconstruction.com' },
    }),
  });
  try {
    assert.equal(await page.isDisabled('input[name="role-punchItemManagerId"][value="me"]'), true);
    assert.match(await page.textContent('#roles-card'), /not in this project's directory/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('"Connected as" names the super even when Procore gave no name', async () => {
  const { page, errors } = await openApp({
    meReply: () => ({ ...CONNECTED(), procore: { ...CONNECTED().procore, name: null, login: null } }),
  });
  try {
    // No name from Procore: the project directory row for their Procore id names them.
    await page.waitForFunction(() => /connected as Test Super/.test(document.getElementById('procore-card').textContent));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('"Connected as" falls back to the Microsoft account, never to nobody', async () => {
  const { page, errors } = await openApp({
    meReply: () => ({ email: 'new.super@buffaloconstruction.com', procore: { ...CONNECTED().procore, name: '  ', login: null, procoreUserId: null } }),
  });
  try {
    // Not in the directory either: the Microsoft account is all that names them.
    await page.waitForFunction(() => /connected as new\.super@buffaloconstruction\.com/.test(document.getElementById('procore-card').textContent));
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

// ── The safety catch: the first item goes alone (2026-10-14) ────────────────
//
// An item that is created Initiated, or with people on its distribution list,
// may have emailed them. That is how subs got hundreds of emails. The first item
// goes alone, and anything but a quiet Draft stops the push there.

test('an item that does not come back a quiet Draft stops the push after one item', async () => {
  const { page, pushes, errors } = await toCreateStep({
    onPush: (body) => ({
      json: {
        results: body.items.map((it) => ({
          clientId: it.clientId,
          ok: true,
          punchItemId: 501,
          observed: { isDraft: false, workflowLabel: 'initiated', distributionMembers: ['Dana Sub'] },
        })),
        safetyStop: { punchItemId: 501, reason: 'it came back initiated' },
        quota: null,
      },
    }),
  });
  try {
    await page.click('#next-btn');
    await page.waitForFunction(() => /did not come back as a quiet Draft/.test(document.getElementById('results').textContent));
    assert.deepEqual(pushes.map((p) => p.items.length), [1], 'one item, then nothing');
    const text = await page.textContent('#results');
    assert.match(text, /it came back initiated/);
    assert.match(text, /On its distribution list: Dana Sub/);
    assert.match(text, /11 items were not sent/);
    assert.doesNotMatch(text, /rate limit/i, 'a safety stop is not reported as a rate limit');
    assert.match(await page.textContent('#next-btn'), /Create 11 punch items/, 'the rest stay selected');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
