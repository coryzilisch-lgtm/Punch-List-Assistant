/**
 * The name/company picker, driven in a real browser.
 *
 * Both bugs this covers are invisible to `node --check`: one is a filter that
 * only looked at half the data, the other is an event listener that tore the
 * popup down when you scrolled it. A syntax check cannot catch a runtime
 * behaviour — only running it can, which is the lesson the sibling dashboard
 * learned by shipping a page that threw before a single handler bound.
 *
 * This loads the REAL `dashboard/app.js` module — not a copy of the functions —
 * against a stub of the two shapes it needs, so a refactor that breaks the
 * picker fails here.
 *
 *   node tools/dashboard-test/combo.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DASHBOARD = path.resolve(fileURLToPath(new URL('../../dashboard', import.meta.url)));

const PEOPLE = [
  { id: 1, name: 'Dave Smith', company: 'Apex Glass' },
  { id: 2, name: 'Mike Jones', company: 'Zeta Roofing' },
  { id: 3, name: 'Sara Patel', company: 'Zeta Roofing' },
  { id: 4, name: 'Tom Nguyen', company: 'Smith Electric' },
  // Enough rows to make the popup taller than its 300px max-height, which is
  // what makes it scrollable — the bug does not reproduce on a short list.
  ...Array.from({ length: 40 }, (_, i) => ({
    id: 100 + i,
    name: `Filler Person ${String(i).padStart(2, '0')}`,
    company: 'Zeta Roofing',
  })),
];

/** Serve the real dashboard directory — the test drives the shipped files. */
function serve() {
  const types = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.mjs': 'text/javascript',
  };
  const server = http.createServer((req, res) => {
    const rel = req.url.split('?')[0];
    const file = path.join(DASHBOARD, rel === '/' ? '/index.html' : rel);
    if (!file.startsWith(DASHBOARD) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port })));
}

/** Enough of the API for the real page to boot without reaching Procore. */
const API = {
  '/api/me': { email: 'test@buffaloconstruction.com' },
  '/api/projects': { projects: [], source: 'stub' },
};

/**
 * Boot the REAL index.html, then seed the picker and put one combo on the page.
 *
 * Reaching the review screen for real would mean uploading a PDF and running an
 * extraction, which tests the wrong thing at ten times the cost. The combo
 * markup here is exactly what `nameCombo()` emits, and every listener under test
 * is document-level and already wired by the page's own `init()`.
 */
let shared = null;

/** One browser and one server for the file — launching per test cost 13s each. */
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

async function withPage(fn) {
  const { browser, port } = await harness();
  const page = await browser.newPage();
  try {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url());
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(API[url.pathname] ?? {}),
      });
    });

    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'networkidle' });

    await page.evaluate((people) => {
      // The module is already imported and wired by the page; reach its seam.
      return import('./app.js').then((mod) => {
        mod.__test.setConfig({ users: people, vendors: [], trades: [], punchItemTypes: [], locations: [] });
        const input = document.createElement('input');
        input.className = 'namecombo';
        input.type = 'text';
        Object.assign(input.dataset, { combo: 'person', act: 'assigneeId', scope: 'default', value: '' });
        input.style.cssText = 'width:320px;position:relative;z-index:5';
        document.body.prepend(input);
      });
    }, PEOPLE);

    await fn(page, errors);
    assert.deepEqual(errors, [], 'the page must raise no uncaught errors');
  } finally {
    await page.close();
  }
}

/**
 * The real options, excluding the "— None —" clear row.
 *
 * That row carries `data-id=""`, so a bare `li[data-id]` selector picks it up —
 * which is also why the keyboard handler treats index 0 as the clear row.
 */
const optionText = (page) =>
  page.$$eval('#name-popup li[data-id]:not(.name-clear)', (els) =>
    els.map((e) => {
      // Read the name by removing the company span, NOT by taking firstChild:
      // `highlight()` wraps each matched term in <mark>, so a matching name is
      // several text nodes and firstChild is only the part before the match.
      const clone = e.cloneNode(true);
      const sub = clone.querySelector('.combo-sub');
      const company = sub?.textContent.trim() ?? '';
      sub?.remove();
      return `${clone.textContent.trim()} · ${company}`;
    }),
  );

test('typing a company name filters to that company', async () => {
  await withPage(async (page) => {
    await page.click('.namecombo');
    await page.fill('.namecombo', 'Zeta Roofing');
    await page.waitForTimeout(50);

    const names = await optionText(page);
    assert.ok(names.length > 0, 'a company name must match somebody');
    assert.ok(
      names.every((n) => n.endsWith('· Zeta Roofing')),
      `every row should be at Zeta Roofing, got: ${names.slice(0, 3).join(' | ')}`,
    );
    assert.ok(names.some((n) => n.includes('Mike Jones')), 'Zeta’s people must be offered');
    assert.ok(!names.some((n) => n.includes('Dave Smith')), 'Apex Glass must be filtered out');
  });
});

test('a name still matches, and outranks a company that shares the word', async () => {
  await withPage(async (page) => {
    await page.click('.namecombo');
    await page.fill('.namecombo', 'smith');
    await page.waitForTimeout(50);

    const names = await optionText(page);
    // Dave Smith (the person) must come before Tom Nguyen (at Smith Electric).
    assert.ok(names[0].startsWith('Dave Smith'), `expected Dave Smith first, got ${names[0]}`);
    assert.ok(names.some((n) => n.includes('Tom Nguyen')), 'Smith Electric’s people still match');
  });
});

test('mixing a company and a name narrows to one person', async () => {
  await withPage(async (page) => {
    await page.click('.namecombo');
    await page.fill('.namecombo', 'zeta mike');
    await page.waitForTimeout(50);
    assert.deepEqual(await optionText(page), ['Mike Jones · Zeta Roofing']);
  });
});

/**
 * THE REPORTED BUG. The scroll listener was registered in the CAPTURE phase, so
 * it saw scroll events from every element — including the popup, which is
 * `max-height: 300px; overflow-y: auto`. Scrolling the list closed it, which on
 * a real 200-person directory made everything past the first dozen unreachable.
 */
test('scrolling the popup does not close it', async () => {
  await withPage(async (page) => {
    await page.click('.namecombo');
    await page.waitForSelector('#name-popup:not([hidden])');

    const scrollable = await page.$eval('#name-popup', (el) => el.scrollHeight > el.clientHeight);
    assert.ok(scrollable, 'the fixture must produce a scrollable popup or it proves nothing');

    await page.hover('#name-popup');
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(100);

    assert.equal(await page.$eval('#name-popup', (el) => el.hidden), false, 'popup closed on scroll');
    assert.ok(
      await page.$eval('#name-popup', (el) => el.scrollTop > 0),
      'the popup should actually have scrolled',
    );
  });
});

/** Dragging the scrollbar must not blur the input out from under the popup. */
test('pressing inside the popup keeps it open', async () => {
  await withPage(async (page) => {
    await page.click('.namecombo');
    await page.waitForSelector('#name-popup:not([hidden])');
    const box = await page.$eval('#name-popup', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.right - 4, y: r.top + 40 }; // over the scrollbar gutter
    });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.waitForTimeout(50);
    assert.equal(await page.$eval('#name-popup', (el) => el.hidden), false);
    await page.mouse.up();
  });
});

/** Scrolling the PAGE still dismisses or follows — it must not leave a stray popup. */
test('scrolling the page keeps the popup aligned to its input', async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '2000px';
      document.body.appendChild(spacer);
    });
    await page.click('.namecombo');
    await page.waitForSelector('#name-popup:not([hidden])');
    await page.mouse.move(5, 5); // away from the popup
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(100);

    const gap = await page.evaluate(() => {
      const popup = document.getElementById('name-popup');
      if (popup.hidden) return 0; // dismissed is acceptable
      const input = document.querySelector('.namecombo').getBoundingClientRect();
      return Math.abs(popup.getBoundingClientRect().top - input.bottom);
    });
    assert.ok(gap <= 8, `popup drifted ${gap}px from its input`);
  });
});
