/**
 * Photo detection — pure pixel maths, no DOM.
 *
 * Kept free of any browser API on purpose. The app runs this on a canvas in the
 * browser, the CLI harness in `tools/extract-cli` runs it on a Node-rendered
 * bitmap, and the tests run it on synthetic pixel buffers. One implementation,
 * so what a developer verifies offline is what a superintendent gets.
 */

/** Page pixels per grid cell. */
const CELL = 8;

/** A cell counts as photo-like above this score. */
const PHOTO_CELL = 0.45;

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
 *
 * This finds image-shaped regions, which is all pixels can tell you. It cannot
 * tell a defect photo from a header logo or a QR code — that judgement needs to
 * see the page as a document, and happens during extraction.
 *
 * @param {Uint8ClampedArray|Uint8Array} pixels RGBA, 4 bytes per pixel.
 * @param {number} width
 * @param {number} height
 * @returns {Array<{left:number,right:number,top:number,bottom:number}>} normalized 0–1,
 *          in top-to-bottom then left-to-right reading order.
 */
export function detectPhotoRegions(pixels, width, height) {
  const cols = Math.floor(width / CELL);
  const rows = Math.floor(height / CELL);
  if (cols < 8 || rows < 8) return [];

  const dense = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let mid = 0;
      let saturated = 0;
      let total = 0;
      for (let y = cy * CELL; y < (cy + 1) * CELL; y += 2) {
        for (let x = cx * CELL; x < (cx + 1) * CELL; x += 2) {
          const o = (y * width + x) * 4;
          const r = pixels[o];
          const g = pixels[o + 1];
          const b = pixels[o + 2];
          const max = r > g ? (r > b ? r : b) : g > b ? g : b;
          const min = r < g ? (r < b ? r : b) : g < b ? g : b;
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 42 && lum < 226) mid++;
          if (max - min > 26) saturated++;
          total++;
        }
      }
      // Colour is strong evidence on its own: printed punch lists are greyscale
      // apart from small status chips, which the size filters below discard.
      const score = Math.max(mid / total, (saturated / total) * 1.4);
      dense[cy * cols + cx] = score >= PHOTO_CELL ? 1 : 0;
    }
  }

  const minCells = Math.max(24, Math.round(cols * rows * 0.004));
  const out = [];

  for (const box of connectedBoxes(dense, cols, rows)) {
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

  // Reading order: top to bottom, then left to right. The extraction prompt tells
  // Claude the photos are numbered in this order, so it must hold. Rows are
  // bucketed before sorting horizontally, otherwise two photos side by side with
  // a few pixels of vertical offset would sort as two separate rows.
  const ROW_GAP = 0.04;
  out.sort((a, b) => {
    if (Math.abs(a.top - b.top) > ROW_GAP) return a.top - b.top;
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

    const push = (n) => {
      if (dense[n] && !seen[n]) {
        seen[n] = 1;
        stack[sp++] = n;
      }
    };

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
  }

  return boxes;
}
