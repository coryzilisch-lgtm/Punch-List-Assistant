/**
 * The "Use the Sandbox" shortcut, driven through the real dashboard.
 *
 * The button is a convenience for choosing project 603781, the Sandbox Test
 * Project. The Sandbox is a real project in the live tenant, so the shortcut
 * must not be a way around anything a normal project goes through. These tests
 * hold that, plus the strip that says where items are going.
 *
 *   node tools/dashboard-test/sandbox.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DASHBOARD = path.resolve(fileURLToPath(new URL('../../dashboard', import.meta.url)));
const SANDBOX = 603781;
const SANDBOX_PROJECT = { id: SANDBOX, name: 'Sandbox Test Project', number: '1234', stage: 'Bidding', active: true };

function serve() {
  const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png' };
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

const CONFIG = { users: [], vendors: [], trades: [], punchItemTypes: [], locations: [] };

async function openApp({ projects = [{ id: 1, name: 'Test Job' }], byId } = {}) {
  const { browser, port } = await harness();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const calls = { byId: 0, probes: [] };

  await page.context().route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === `/api/projects/${SANDBOX}`) {
      calls.byId += 1;
      return byId ? byId(send) : send({ project: SANDBOX_PROJECT });
    }
    switch (url.pathname) {
      case '/api/me':
        return send({
          email: 'test@buffaloconstruction.com',
          procore: { configured: true, connected: true, name: 'Test Super', procoreUserId: 5520, expiresAt: Date.now() + 3_600_000 },
        });
      case '/api/projects':
        return send({ projects, source: 'stub' });
      case '/api/probe':
        calls.probes.push(url.searchParams.get('project_id'));
        return send({ checks: [], config: CONFIG });
      default:
        return send({});
    }
  });

  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#project-pick', { state: 'visible' });
  return { page, errors, calls };
}

const stripShown = (page) => page.evaluate(() => !document.getElementById('sandbox-strip').hidden);

test('the Sandbox button selects project 603781 by id when the mirror does not list it', async () => {
  const { page, errors, calls } = await openApp();
  try {
    assert.equal(await stripShown(page), false, 'no strip before anything is chosen');
    await page.click('#sandbox-btn');
    await page.waitForFunction(() => /Sandbox Test Project/.test(document.getElementById('project-chosen').textContent));
    await page.waitForFunction(() => document.getElementById('readiness-card').style.display === 'block');

    assert.equal(calls.byId, 1);
    assert.deepEqual(calls.probes, [String(SANDBOX)], 'the connection check ran against the Sandbox');
    assert.equal(await page.inputValue('#project-search'), 'Sandbox Test Project');
    assert.equal(await stripShown(page), true);
    assert.match(await page.textContent('#sandbox-name'), /Sandbox Test Project/);
    assert.match(await page.textContent('#sandbox-strip'), /Buffalo staff/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('no lookup is made when the project list already has the Sandbox', async () => {
  const { page, errors, calls } = await openApp({ projects: [{ id: 1, name: 'Test Job' }, SANDBOX_PROJECT] });
  try {
    await page.click('#sandbox-btn');
    await page.waitForFunction(() => !document.getElementById('sandbox-strip').hidden);
    assert.equal(calls.byId, 0);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('choosing the Sandbox does not skip the distribution-email gate', async () => {
  // It is a real project in the live tenant: Initiated items email people there too.
  const { page, errors } = await openApp();
  try {
    await page.click('#sandbox-btn');
    await page.waitForSelector('#dist-gate-check');
    assert.ok(await page.isDisabled('#next-btn'), 'Continue stays locked until the gate is ticked');
    assert.match(await page.textContent('#bar-summary'), /distribution emails/i);

    await page.click('#dist-gate-check');
    await page.waitForFunction(() => !document.getElementById('next-btn').disabled);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('the strip belongs to the Sandbox only: another project or clearing hides it', async () => {
  const { page, errors } = await openApp();
  try {
    await page.click('#sandbox-btn');
    await page.waitForFunction(() => !document.getElementById('sandbox-strip').hidden);

    await page.click('#project-clear');
    assert.equal(await stripShown(page), false, 'cleared');
    await page.keyboard.press('Escape'); // Clear refocuses the box, which opens the list over the button.

    await page.click('#sandbox-btn');
    await page.waitForFunction(() => !document.getElementById('sandbox-strip').hidden);
    await page.fill('#project-search', 'Test Job');
    await page.click('#project-list li[data-id="1"]');
    await page.waitForFunction(() => /Test Job/.test(document.getElementById('project-chosen').textContent));
    assert.equal(await stripShown(page), false, 'a normal project is not flagged as the Sandbox');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('if Procore cannot find the Sandbox the button says so and selects nothing', async () => {
  const { page, errors } = await openApp({ byId: (send) => send({ error: 'Project not found' }, 404) });
  try {
    await page.click('#sandbox-btn');
    await page.waitForFunction(() => /Couldn.t open the Sandbox/.test(document.getElementById('sandbox-result').textContent));
    assert.match(await page.textContent('#sandbox-result'), /Project not found/);
    assert.equal(await stripShown(page), false);
    assert.ok(await page.isDisabled('#next-btn'), 'nothing was selected');
    assert.ok(!(await page.isDisabled('#sandbox-btn')), 'the button can be pressed again');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
