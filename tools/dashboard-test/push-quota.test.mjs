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
 * manager in the bulk card, press Create. Only `/api/*` is stubbed.
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
  users: [{ id: 4410, name: 'Pat Manager', company: 'Buffalo Construction Inc.' }],
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
async function toCreateStep({ quotaReply, onPush }) {
  const { browser, port } = await harness();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const pushes = [];
  const quotaCalls = [];

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const send = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (url.pathname) {
      case '/api/me':
        return send({ email: 'test@buffaloconstruction.com' });
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
  await page.waitForFunction(() => !document.getElementById('next-btn').disabled);
  await page.click('#next-btn'); // → upload

  await page.setInputFiles('#file-input', { name: 'list.pdf', mimeType: 'application/pdf', buffer: onePagePdf() });
  await page.waitForFunction(() => !document.getElementById('next-btn').disabled, null, { timeout: 20_000 });
  await page.click('#next-btn'); // → review

  // The bulk card's manager picker, then Apply: the same thing a super does.
  const combo = page.locator('input.namecombo[data-act="punchItemManagerId"][data-scope="default"]');
  await combo.click();
  await combo.fill('Pat');
  await page.locator('#name-popup li[data-id="4410"]').click();
  await page.click('#apply-defaults');

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

    await page.click('#next-btn');
    await page.waitForFunction(() => document.getElementById('results').textContent.includes('Stopped'));

    assert.deepEqual(pushes.map((p) => p.items.length), [5, 2], 'two batches, nothing past the quota');
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
  // not be sent. On the Darden import it was, eleven times over.
  const resetAt = Date.now() + 30 * 60_000;
  const { page, pushes, errors } = await toCreateStep({
    quotaReply: quota({ limit: null, remaining: null, resetAt: null, capacity: null }),
    onPush: (body, n) =>
      n === 1
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

    assert.equal(pushes.length, 2, 'the third batch was never sent');
    const results = await page.textContent('#results');
    assert.match(results, /6 punch items created/);
    // 4 refused in batch two + 2 never attempted.
    assert.match(results, /6 items were not created/);
    assert.match(await page.textContent('#next-btn'), /Create 6 punch items/, 'all six not created stay selected');
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

    assert.deepEqual(pushes.map((p) => p.items.length), [5, 5, 2], 'paced batches, every item sent once');
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
      if (n !== 1) return created(body, n * 100);
      // First batch: two land, three hit the window. Those three were never written.
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
      n === 1
        ? { json: { ...created(body).json, requests: 10 } }
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
    // 10 for the first batch + 1 for the refused one. The quota check made on
    // opening the step is reused, not asked again, so it is not part of this push.
    assert.match(text, /This import had used 11 Procore requests/);
    assert.match(text, /used 11 Procore requests for 5 items created \(about 2\.2 each\)/);
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
