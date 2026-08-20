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
import { detectPhotoRegions } from './photo-detect.js';

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
  const regions = findPhotos(pageCanvas);

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
 * Read the page's pixels and hand them to the shared detector.
 *
 * The algorithm itself lives in `photo-detect.js` with no DOM dependency, so the
 * CLI harness and the tests exercise the same code this does.
 */
function findPhotos(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return detectPhotoRegions(data, canvas.width, canvas.height);
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
