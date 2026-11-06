/**
 * The project list when Procore is connected after the page has opened.
 *
 * The list is asked for once, when the page opens. Without a usable mirror the
 * API falls back to Procore, which needs the super's own token, and on a first
 * visit there is none yet: the list fails. Connecting Procore used to refresh the
 * connection and nothing else, so the super had to reload the page to see their
 * projects. These tests hold that the list loads by itself after connecting.
 *
 * The connection result is delivered the way the popup delivers it, as a
 * same-origin message, so the real handler runs.
 *
 *   node tools/dashboard-test/connect-projects.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DASHBOARD = path.resolve(fileURLToPath(new URL('../../dashboard', import.meta.url)));
const PROJECTS = [{ id: 1, name: 'Test Job' }, { id: 2, name: 'Other Job' }];
const CONFIG = { users: [], vendors: [], trades: [], punchItemTypes: [], locations: [] };

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

/** `server.connected` stands in for the Procore cookie the callback sets. */
async function openApp({ connected, query = '' }) {
  const { browser, port } = await harness();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const server = { connected, me: 0, projects: 0, probes: 0 };

  await page.context().route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    switch (url.pathname) {
      case '/api/me':
        server.me += 1;
        return send({
          email: 'test@buffaloconstruction.com',
          procore: server.connected
            ? { configured: true, connected: true, name: 'Test Super', procoreUserId: 5520, expiresAt: Date.now() + 3_600_000 }
            : { configured: true, connected: false },
        });
      case '/api/projects':
        server.projects += 1;
        return server.connected
          ? send({ projects: PROJECTS, source: 'procore' })
          : send({ error: 'Connect your Procore account first.', procoreConnect: true }, 401);
      case '/api/probe':
        server.probes += 1;
        return send({ checks: [], config: CONFIG });
      default:
        return send({});
    }
  });

  await page.goto(`http://127.0.0.1:${port}/index.html${query}`, { waitUntil: 'networkidle' });
  return { page, errors, server };
}

/** What the connect popup does when Procore says yes. */
const popupSaysConnected = (page) =>
  page.evaluate(() => window.postMessage({ type: 'procore-connect', ok: true, at: Date.now() }, location.origin));

test('projects load by themselves once Procore connects, with no page refresh', async () => {
  const { page, errors, server } = await openApp({ connected: false });
  try {
    await page.waitForFunction(() => /Connect Procore to see your projects/.test(document.getElementById('project-error').textContent));
    assert.equal(await page.isVisible('#project-pick'), false, 'no list yet');
    assert.doesNotMatch(await page.textContent('#project-error'), /Couldn.t load/, 'not-connected is not shown as a failure');
    await page.evaluate(() => { window.__sameDocument = true; });

    server.connected = true;
    await popupSaysConnected(page);

    await page.waitForSelector('#project-pick', { state: 'visible' });
    assert.equal(await page.getAttribute('#project-search', 'placeholder'), 'Start typing — 2 projects');
    assert.equal((await page.textContent('#project-error')).trim(), '', 'the notice is gone');
    assert.equal(await page.evaluate(() => window.__sameDocument), true, 'the page was not reloaded');
    assert.equal(server.projects, 2, 'asked once at load, once after connecting');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a list that already loaded is not fetched again on connect', async () => {
  const { page, errors, server } = await openApp({ connected: true });
  try {
    await page.waitForSelector('#project-pick', { state: 'visible' });
    const meBefore = server.me;
    await popupSaysConnected(page);
    await page.waitForFunction(() => true);
    await page.waitForTimeout(300);
    assert.ok(server.me > meBefore, 'the connection was re-checked');
    assert.equal(server.projects, 1, 'the list was not asked for twice');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a project handed over in the URL is chosen once the list arrives, and checked once', async () => {
  const { page, errors, server } = await openApp({ connected: false, query: '?project_id=1' });
  try {
    await page.waitForFunction(() => /Connect Procore to see your projects/.test(document.getElementById('project-error').textContent));
    server.connected = true;
    await popupSaysConnected(page);
    await page.waitForFunction(() => /Test Job/.test(document.getElementById('project-chosen').textContent));
    await page.waitForFunction(() => document.getElementById('readiness-card').style.display === 'block');
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('#project-search'), 'Test Job');
    assert.equal(server.probes, 1, 'the connection check ran once, not twice');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
