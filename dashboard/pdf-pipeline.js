/**
 * PDF page rendering and photo extraction — runs entirely in the browser.
 *
 * Why here and not in the API: rendering a PDF page to a bitmap needs pdf.js
 * plus a canvas, and SWA managed Functions cannot install the native canvas
 * dependency and cap a deployment at ~15,000 files. The browser already has a
 * canvas. It also means a 40 MB punch list never leaves the super's device —
 * only the rendered pages and the cropped photos do, which are far smaller.
 */

import * as pdfjs from './vendor/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.mjs';

/**
 * Render scale. 150 DPI (2.08x the 72 DPI PDF unit) is the sweet spot: enough
 * resolution to read small punch list text reliably, small enough that a page
 * encodes to well under a megabyte of JPEG.
 */
const RENDER_SCALE = 150 / 72;

/** Photos are cropped from a higher-resolution render so they stay usable in Procore. */
const PHOTO_SCALE = 220 / 72;

export async function loadPdf(arrayBuffer) {
  const task = pdfjs.getDocument({ data: arrayBuffer });
  return task.promise;
}

/**
 * Render one page and pull the photos out of it.
 * Returns { pageNumber, pageImage, photos: [{index, dataUrl, top, bottom, left, right}] }
 */
export async function processPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);

  const pageCanvas = await renderPage(page, RENDER_SCALE);
  const regions = detectPhotoRegions(pageCanvas);

  let photos = [];
  if (regions.length) {
    // Re-render at higher resolution only when there is something to crop.
    const hi = await renderPage(page, PHOTO_SCALE);
    photos = regions.map((r, i) => ({
      index: i,
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
      dataUrl: cropNormalized(hi, r),
    }));
  }

  return {
    pageNumber,
    pageImage: pageCanvas.toDataURL('image/jpeg', 0.82),
    pageWidth: pageCanvas.width,
    pageHeight: pageCanvas.height,
    photos,
  };
}

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Paint white first. PDF pages are transparent where nothing is drawn, and a
  // transparent background reads as black in a JPEG — which would hide the text.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// ── Photo detection ─────────────────────────────────────────────────────────

/**
 * Find the photographs on a rendered page.
 *
 * The distinction that matters is photo vs. text, and the reliable signal is
 * TONE DISTRIBUTION, not darkness. A region of text is overwhelmingly white
 * with a small fraction of near-black pixels; a photograph is mostly mid-tones
 * and usually carries colour. So we score each cell of a coarse grid by the
 * fraction of its pixels that are neither near-white nor near-black, give a
 * boost for colour saturation, and then look for large solid blocks.
 *
 * Rejected alternatives, and why:
 *  - "Dark pixel density" alone: fails on the common punch list photo of a white
 *    wall or a stainless fridge — bright subjects with little dark area.
 *  - Edge detection: a dense table of ruled lines (Excel-style punch lists) is
 *    all edges and would score as one huge photo.
 *  - Trusting the PDF's own embedded image list: works only when the source is a
 *    native PDF. Every scanned punch list is one full-page JPEG per page, so the
 *    image list is a single object covering the whole page — useless.
 */
export function detectPhotoRegions(canvas) {
  const CELL = 8; // page pixels per grid cell
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width, height } = canvas;
  const cols = Math.floor(width / CELL);
  const rows = Math.floor(height / CELL);
  if (cols < 8 || rows < 8) return [];

  const data = ctx.getImageData(0, 0, width, height).data;
  const score = new Float32Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let mid = 0;
      let saturated = 0;
      let total = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y += 2) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x += 2) {
          const o = (y * width + x) * 4;
          const r = data[o];
          const g = data[o + 1];
          const b = data[o + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 42 && lum < 226) mid++;
          if (max - min > 26) saturated++;
          total++;
        }
      }
      const midFrac = mid / total;
      const satFrac = saturated / total;
      // Colour is strong evidence on its own: printed punch lists are greyscale
      // apart from small status chips, which the size filters below discard.
      score[cy * cols + cx] = Math.max(midFrac, satFrac * 1.4);
    }
  }

  const PHOTO_CELL = 0.45;
  const dense = new Uint8Array(cols * rows);
  for (let i = 0; i < score.length; i++) dense[i] = score[i] >= PHOTO_CELL ? 1 : 0;

  const boxes = connectedBoxes(dense, cols, rows);

  const minCells = Math.max(24, Math.round(cols * rows * 0.004));
  const out = [];

  for (const box of boxes) {
    const bw = box.x1 - box.x0 + 1;
    const bh = box.y1 - box.y0 + 1;
    if (box.count < minCells) continue;
    // A photo is a solid rectangle. A run of text or a table border traced by the
    // grid is a sparse skeleton inside its bounding box, so fill ratio separates
    // them cleanly.
    if (box.count / (bw * bh) < 0.62) continue;
    // Must be meaningfully large in BOTH directions — this is what rejects a
    // horizontal rule, a coloured status chip, or a logo strip.
    if (bw / cols < 0.06 || bh / rows < 0.045) continue;
    // Nothing on a punch list is a photo of the whole page. A hit this large
    // means the page itself is a dark scan, and cropping it would produce a
    // "photo" that is just the page again.
    if ((bw * bh) / (cols * rows) > 0.85) continue;

    out.push({
      left: box.x0 / cols,
      right: (box.x1 + 1) / cols,
      top: box.y0 / rows,
      bottom: (box.y1 + 1) / rows,
    });
  }

  // Reading order: top to bottom, then left to right. The extraction prompt
  // tells Claude the photos are numbered in this order, so it must hold.
  // Rows are bucketed before sorting horizontally, otherwise two photos side by
  // side with a few pixels of vertical offset would sort as two separate rows.
  out.sort((a, b) => {
    const rowGap = 0.04;
    if (Math.abs(a.top - b.top) > rowGap) return a.top - b.top;
    return a.left - b.left;
  });

  return out;
}

/** Label connected cells (4-connectivity) and return each blob's bounding box. */
function connectedBoxes(dense, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  const stack = new Int32Array(cols * rows);

  for (let start = 0; start < dense.length; start++) {
    if (!dense[start] || seen[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;

    let x0 = cols;
    let x1 = -1;
    let y0 = rows;
    let y1 = -1;
    let count = 0;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % cols;
      const y = (idx - x) / cols;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;

      if (x > 0) push(idx - 1);
      if (x < cols - 1) push(idx + 1);
      if (y > 0) push(idx - cols);
      if (y < rows - 1) push(idx + cols);
    }

    boxes.push({ x0, x1, y0, y1, count });

    function push(n) {
      if (dense[n] && !seen[n]) {
        seen[n] = 1;
        stack[sp++] = n;
      }
    }
  }

  return boxes;
}

/** Crop a normalized region out of a canvas and return it as a JPEG data URL. */
function cropNormalized(canvas, region) {
  // Trim a hair off each edge: the detected box includes the photo's border
  // pixels and, on app-exported layouts, sometimes a sliver of the table rule.
  const inset = 0.004;
  const sx = Math.max(0, Math.round((region.left + inset) * canvas.width));
  const sy = Math.max(0, Math.round((region.top + inset) * canvas.height));
  const sw = Math.min(canvas.width - sx, Math.round((region.right - region.left - inset * 2) * canvas.width));
  const sh = Math.min(canvas.height - sy, Math.round((region.bottom - region.top - inset * 2) * canvas.height));
  if (sw <= 0 || sh <= 0) return null;

  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/jpeg', 0.85);
}
