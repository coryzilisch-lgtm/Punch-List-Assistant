#!/usr/bin/env node
/**
 * Run the punch list extractor against a PDF from the command line.
 *
 * The point is to judge extraction quality on a real owner's document without
 * standing up Azure first. It renders and detects exactly the way the browser
 * does — same `photo-detect.js`, same `extract.ts` prompt and schema, imported
 * rather than reimplemented — so what you see here is what the deployed app
 * produces.
 *
 * Lives outside `api/` deliberately. Its two dependencies (pdfjs-dist and a
 * native canvas) would otherwise ride along into the Static Web App deployment,
 * which is exactly the weight the browser-side design exists to avoid.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node run.mjs ../../docs/punchlist.pdf
 *
 * Options:
 *   --pages 1-5      only these pages (default: all)
 *   --out DIR        write page renders and cropped photos here, to eyeball them
 *   --no-ai          render and detect photos only; makes no API calls, costs nothing
 *   --json FILE      write the full result as JSON
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const has = (name) => argv.includes(name);

const pdfPath = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--pages' &&
  argv[argv.indexOf(a) - 1] !== '--out' && argv[argv.indexOf(a) - 1] !== '--json');

if (!pdfPath) {
  console.error('Usage: node run.mjs <file.pdf> [--pages 1-5] [--out DIR] [--json FILE] [--no-ai]');
  process.exit(2);
}
if (!fs.existsSync(pdfPath)) {
  console.error(`No such file: ${pdfPath}`);
  process.exit(2);
}

const useAi = !has('--no-ai');
const outDir = flag('--out');
const jsonOut = flag('--json');

let pageFilter = null;
const pagesArg = flag('--pages');
if (pagesArg) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(pagesArg);
  if (!m) {
    console.error('--pages expects a number or a range like 3-7');
    process.exit(2);
  }
  pageFilter = [Number(m[1]), Number(m[2] || m[1])];
}

// ── Dependencies, with honest failure messages ──────────────────────────────

let createCanvas;
try {
  ({ createCanvas } = require('@napi-rs/canvas'));
} catch {
  console.error(
    'Missing dependencies. Run `npm install` in tools/extract-cli first.\n' +
      '(@napi-rs/canvas ships prebuilt binaries — there is nothing to compile.)',
  );
  process.exit(2);
}

const extractDist = path.join(repoRoot, 'api', 'dist', 'lib', 'extract.js');
if (useAi && !fs.existsSync(extractDist)) {
  console.error(
    'The API is not built, so the extraction code cannot be imported.\n' +
      'Run `npm install && npm run build` in api/ first.',
  );
  process.exit(2);
}

const { detectPhotoRegions } = await import(
  pathToFileURL(path.join(repoRoot, 'dashboard', 'photo-detect.js'))
);

if (useAi && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_FOUNDRY_RESOURCE) {
  console.error(
    'No AI credentials. Set ANTHROPIC_API_KEY (direct API) or the ANTHROPIC_FOUNDRY_* ' +
      'settings, or pass --no-ai to test rendering and photo detection only.',
  );
  process.exit(2);
}

// ── PDF rendering (Node) ────────────────────────────────────────────────────

const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const pdfjs = await import(pathToFileURL(path.join(pdfjsDir, 'legacy/build/pdf.mjs')));

const RENDER_SCALE = 150 / 72;
const PHOTO_SCALE = 220 / 72;

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext('2d');
  // Same as the browser path: PDF pages are transparent where nothing is drawn,
  // and transparent encodes to black in a JPEG, which would hide the text.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

function cropNormalized(canvas, region) {
  const inset = 0.004;
  const sx = Math.max(0, Math.round((region.left + inset) * canvas.width));
  const sy = Math.max(0, Math.round((region.top + inset) * canvas.height));
  const sw = Math.min(canvas.width - sx, Math.round((region.right - region.left - inset * 2) * canvas.width));
  const sh = Math.min(canvas.height - sy, Math.round((region.bottom - region.top - inset * 2) * canvas.height));
  if (sw <= 0 || sh <= 0) return null;
  const out = createCanvas(sw, sh);
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toBuffer('image/jpeg', 85);
}

// ── Run ─────────────────────────────────────────────────────────────────────

if (outDir) fs.mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(fs.readFileSync(pdfPath));
const pdf = await pdfjs.getDocument({
  data,
  standardFontDataUrl: path.join(pdfjsDir, 'standard_fonts') + path.sep,
  // No worker thread in the CLI — one page at a time, nothing to keep responsive.
  useWorkerFetch: false,
  isEvalSupported: false,
}).promise;

const total = pdf.numPages;
const [from, to] = pageFilter || [1, total];
console.log(`${path.basename(pdfPath)} — ${total} page(s), reading ${from}${to > from ? `-${to}` : ''}\n`);

let extractPage = null;
if (useAi) ({ extractPage } = require(extractDist));

const allItems = [];
const pageResults = [];
let photoTotal = 0;
let furnitureTotal = 0;

for (let n = from; n <= Math.min(to, total); n++) {
  const started = Date.now();
  const page = await pdf.getPage(n);

  const pageCanvas = await renderPage(page, RENDER_SCALE);
  const ctx = pageCanvas.getContext('2d');
  const { data: pixels } = ctx.getImageData(0, 0, pageCanvas.width, pageCanvas.height);
  const regions = detectPhotoRegions(pixels, pageCanvas.width, pageCanvas.height);
  photoTotal += regions.length;

  let crops = [];
  if (regions.length) {
    const hi = await renderPage(page, PHOTO_SCALE);
    crops = regions.map((r) => cropNormalized(hi, r));
  }

  if (outDir) {
    // Zero-pad filenames, not space-pad: a space in a filename makes every
    // later shell command that touches these need quoting.
    const stem = `page-${String(n).padStart(3, '0')}`;
    fs.writeFileSync(path.join(outDir, `${stem}.jpg`), pageCanvas.toBuffer('image/jpeg', 82));
    crops.forEach((buf, i) => {
      if (buf) fs.writeFileSync(path.join(outDir, `${stem}-photo-${i}.jpg`), buf);
    });
  }

  if (!useAi) {
    console.log(`page ${pad(n)}  ${regions.length} image region(s) detected  (${Date.now() - started}ms)`);
    pageResults.push({ pageNumber: n, regions: regions.length });
    continue;
  }

  let result;
  try {
    result = await extractPage({
      imageBase64: pageCanvas.toBuffer('image/jpeg', 82).toString('base64'),
      imageMediaType: 'image/jpeg',
      pageNumber: n,
      totalPages: total,
      photos: regions.map((r, i) => ({ index: i, ...r })),
    });
  } catch (err) {
    console.log(`page ${pad(n)}  FAILED — ${err?.message || err}`);
    pageResults.push({ pageNumber: n, error: String(err?.message || err) });
    continue;
  }

  const furniture = result.page_furniture_photo_indexes || [];
  furnitureTotal += furniture.length;

  const bits = [
    `page ${pad(n)}`,
    `${result.page_kind.padEnd(5)}`,
    `${String(result.items.length).padStart(2)} item(s)`,
    `${regions.length} image region(s)`,
  ];
  if (furniture.length) bits.push(`${furniture.length} discarded as page furniture`);
  bits.push(`${Date.now() - started}ms`);
  console.log(bits.join('  '));

  for (const item of result.items) {
    const num = item.source_number ? `#${item.source_number}` : '—';
    const conf = item.confidence === 'high' ? ' ' : item.confidence === 'medium' ? '?' : '!';
    const where = item.location ? ` [${item.location}]` : '';
    const pics = item.photo_indexes.length ? ` (${item.photo_indexes.length} photo)` : '';
    console.log(`   ${conf} ${num.padStart(4)}  ${item.title}${where}${pics}`);
    allItems.push({ ...item, page: n });
  }
  if (result.notes) console.log(`     note: ${result.notes}`);

  pageResults.push({ ...result, regions: regions.length });
}

console.log('');
if (useAi) {
  const low = allItems.filter((i) => i.confidence === 'low').length;
  const withPhoto = allItems.filter((i) => i.photo_indexes.length).length;
  console.log(`${allItems.length} items · ${withPhoto} with a photo · ${low} flagged for review`);
  console.log(`${photoTotal} image regions detected · ${furnitureTotal} discarded as page furniture`);
  const numbered = allItems.map((i) => Number(i.source_number)).filter((n) => Number.isFinite(n));
  if (numbered.length > 1) {
    const missing = gaps(numbered);
    console.log(
      missing.length
        ? `source numbering ${Math.min(...numbered)}-${Math.max(...numbered)}, MISSING ${missing.join(', ')}`
        : `source numbering ${Math.min(...numbered)}-${Math.max(...numbered)}, complete`,
    );
  }
} else {
  console.log(`${photoTotal} image regions detected across ${pageResults.length} page(s)`);
}
if (outDir) console.log(`renders and crops written to ${outDir}`);

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({ file: pdfPath, pages: pageResults }, null, 2));
  console.log(`json written to ${jsonOut}`);
}

/**
 * Gaps in the owner's own numbering — the cheapest signal that a page was
 * misread or skipped. If the owner numbered 1-59 and we produced 1-59 with no
 * holes, the read is almost certainly complete.
 */
function gaps(numbers) {
  const seen = new Set(numbers);
  const out = [];
  for (let i = Math.min(...numbers); i <= Math.max(...numbers); i++) {
    if (!seen.has(i)) out.push(i);
  }
  return out;
}

function pad(n) {
  return String(n).padStart(2, ' ');
}
